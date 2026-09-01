import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { Errors } from '../lib/errors';
import { uuid } from '../lib/ids';
import { requireAuth } from '../middleware/auth';
import { ipRateLimit, Limits } from '../middleware/rateLimit';
import { applyMatch, DEFAULT_RATING, DEFAULT_RD, DEFAULT_VOLATILITY,
         type ParticipantOutcome, type RatingMode } from '../elo/glicko2';
import { ratabilityReason, compareReadings, canUpgradeFromConfirmation, WIN_AT,
         matchShape, teamEvidenceMet,
         type UnratedReason } from '../elo/ratability';
import { decideByAbandon, PAIR_COOLDOWN_MS } from '../elo/abandon';
import { sqliteTimestampToMs } from '../lib/time';
import { finalizeRoom } from '../lobbies/discordAnnounce';
import type { AppContext } from '../context';

interface ReportMatchBody {
    lobby_id?: string;
    mod_id: string;
    mod_combined_hash: string;
    map_name?: string;
    started_at: string;
    ended_at: string;
    duration_seconds: number;
    participants: Array<{
        user_id: string;
        team: number;
        civ?: string;
        score: number;
        result: 0 | 0.5 | 1;
    }>;
    /** SHA-256 of the .age3Yrec this result was read from, when there was one.
     *  Optional: most matches are played without a recording. */
    replay_sha256?: string;
    /** The match's own fingerprint from inside the recording — see migration 0005.
     *  Null, never 0, when the file did not carry them. */
    game_seed?: number | null;
    game_host_time?: number | null;
}

/**
 * Accept a recording hash only if it looks like one. A malformed value is dropped
 * rather than stored: a junk string in a UNIQUE column would happily collide with
 * the next junk string and report an honest match as a duplicate.
 */
/** The roster frozen at Start, or null when the room predates the column (or the
 *  value is unreadable, which is the same thing as far as trusting it goes). */
function parseRoster(json: string | null): Set<string> | null {
    if (!json) return null;
    try {
        const arr = JSON.parse(json);
        if (!Array.isArray(arr)) return null;
        return new Set(arr.filter((v): v is string => typeof v === 'string'));
    } catch {
        return null;
    }
}

interface ConfirmationRow {
    user_id: string;
    result: number;
    replay_sha256: string | null;
    game_seed: number | null;
    game_host_time: number | null;
}

/** The match's own fingerprint, to compare a confirmation against. */
interface GameFingerprint {
    seed: number | null;
    hostTime: number | null;
}

/**
 * Tie a lobby's stored confirmations to a match and write down whether they agree.
 *
 * <p>The log line IS the product of this feature. Nothing here gates anything: the
 * match has already been inserted and already been rated or not by the time this
 * runs, and the whole call is wrapped by its caller so that a failure changes
 * nothing about the report.</p>
 *
 * <p>Called from both directions, because either side can arrive first: the host's
 * report ties whatever confirmations are already waiting, and a confirmation that
 * lands after the report ties itself.</p>
 */
async function tieConfirmations(
    ctx: AppContext,
    log: FastifyBaseLogger,
    lobbyId: string,
    matchId: string,
    reported: ReadonlyMap<string, number>,
    fingerprint: GameFingerprint,
): Promise<void> {
    const rows = await ctx.db.prepare(
        `SELECT user_id, result, replay_sha256, game_seed, game_host_time
         FROM match_confirmations WHERE lobby_id = ?`,
    ).bind(lobbyId).all<ConfirmationRow>();

    for (const row of rows.results ?? []) {
        const reportedResult = reported.get(row.user_id);
        const agreement = reportedResult === undefined
            // Confirmed by somebody the host did not list as a player at all. Not a
            // disagreement about the outcome — a disagreement about who was playing.
            ? 'not_reported'
            : compareReadings(reportedResult, row.result);

        // Were the two of them even reading the same GAME? (See the note below on why the
        // host clock is recorded but takes no part in the verdict.)
        const sameGameEarly = fingerprint.seed === null || row.game_seed === null
            ? 'unknown'
            : String(fingerprint.seed === row.game_seed);

        // Stored, not only logged. The log rotates and is gone, and this is the number that
        // decides whether agreement between the two players can ever be REQUIRED — which is
        // the entire reason match_confirmations exists (see migration 0004). Leaving it in a
        // log meant it was never accumulating anywhere it could be counted.
        await ctx.db.prepare(
            `UPDATE match_confirmations SET match_id = ?, agreement = ?, same_game = ?
             WHERE lobby_id = ? AND user_id = ?`,
        ).bind(matchId, agreement, sameGameEarly, lobbyId, row.user_id).run();

        // Were the two of them even reading the same GAME? Decided on the seed alone:
        // both machines must generate the same map, so they must share it. The host
        // clock is recorded beside it but deliberately does NOT take part in the
        // verdict — only one side of a match was ever available to measure, so whether
        // the guest's recording carries the same value is plausible and unproven. When
        // the two-machine test settles it, this is the line that promotes it.
        const sameGame = sameGameEarly;
        const hostTimeMatches = fingerprint.hostTime === null || row.game_host_time === null
            ? 'unknown'
            : fingerprint.hostTime === row.game_host_time;

        log.info(
            {
                match_id: matchId,
                lobby_id: lobbyId,
                user_id: row.user_id,
                reported: reportedResult ?? null,
                confirmed: row.result,
                agreement,
                same_game: sameGame,
                host_time_matches: hostTimeMatches,
                // Both reading the same file would mean one of them copied it; worth
                // seeing if it ever happens.
                same_recording: row.replay_sha256 !== null,
            },
            'match confirmation compared',
        );
    }
}

/**
 * Decide a match that was stored WITHOUT a result, from one player's late reading.
 *
 * <p><b>The failure this closes.</b> Only the host reports, and only the host's reading of
 * their own recording counted — so a match whose host could not read one stayed unrated
 * forever even when the other player's recording named the winner perfectly. Two halves of
 * one real incident had exactly that shape: in one the host's recording had no outcome
 * trailer, in the other the host found no recording at all, and in BOTH the answer was
 * sitting on the other player's disk, correctly read, and sent here — where it was filed as
 * evidence and thrown away.</p>
 *
 * <p><b>Reporting stays host-only.</b> This is not a second reporter: the row already exists
 * and this only corrects it. Who may correct it, and to what, is
 * {@link canUpgradeFromConfirmation} — the short version being that you may concede your own
 * defeat freely and claim your own victory only with a matching fingerprint, so a liar can
 * only ever give points away.</p>
 *
 * <p><b>Double-rating is the worst outcome here and the guard is the conditional UPDATE.</b>
 * Both call sites can fire for one match, and a client can resend. So the row is CLAIMED
 * first — UPDATE ... WHERE unrated_reason = 'no_decided_result' — and a claim that changes
 * zero rows means somebody else got there and this call must stop before touching Glicko. A
 * read-then-write would not do: applyMatch awaits, and an await is where two requests
 * interleave. If the rating itself then fails, the claim is rolled back rather than leaving a
 * match marked rated with no ratings behind it.</p>
 *
 * <p>Best-effort in every direction: the caller wraps it, and a failure changes nothing about
 * the report or the confirmation that triggered it.</p>
 */
async function maybeUpgradeFromConfirmation(
    ctx: AppContext,
    log: FastifyBaseLogger,
    lobbyId: string,
    matchId: string,
): Promise<void> {
    const match = await ctx.db.prepare(
        `SELECT id, mod_id, map_name, unrated_reason, game_seed, game_host_time
         FROM matches WHERE id = ?`,
    ).bind(matchId).first<{
        id: string; mod_id: string; map_name: string | null;
        unrated_reason: string | null; game_seed: number | null; game_host_time: number | null;
    }>();
    if (!match || match.unrated_reason !== 'no_decided_result') return;

    const roster = await ctx.db.prepare(
        `SELECT roster_at_start FROM lobbies WHERE id = ?`,
    ).bind(lobbyId).first<{ roster_at_start: string | null }>();
    const frozen = parseRoster(roster?.roster_at_start ?? null);

    const participants = await ctx.db.prepare(
        `SELECT user_id FROM match_participants WHERE match_id = ?`,
    ).bind(matchId).all<{ user_id: string }>();
    const players = (participants.results ?? []).map((r) => r.user_id);
    // Rule 3 of the resolver, restated here because the correction writes BOTH scores:
    // "X lost" only names a winner when there are exactly two of them.
    if (players.length !== 2) return;

    const confirmations = await ctx.db.prepare(
        `SELECT user_id, result, replay_sha256, game_seed, game_host_time
         FROM match_confirmations WHERE lobby_id = ?`,
    ).bind(lobbyId).all<ConfirmationRow>();

    for (const row of confirmations.results ?? []) {
        if (!players.includes(row.user_id)) continue;

        // One game, one row: a recording that already decided some other match cannot decide
        // this one as well. Only asked when we would actually adopt the fingerprint.
        let fingerprintAlreadyUsed = false;
        if (match.game_seed === null && row.game_seed !== null && row.game_host_time !== null) {
            const clash = await ctx.db.prepare(
                `SELECT 1 FROM matches WHERE game_seed = ? AND game_host_time = ? AND id <> ? LIMIT 1`,
            ).bind(row.game_seed, row.game_host_time, matchId).first();
            fingerprintAlreadyUsed = !!clash;
        }

        const decision = canUpgradeFromConfirmation({
            storedReason: match.unrated_reason,
            storedSeed: match.game_seed,
            storedHostTime: match.game_host_time,
            confirmResult: row.result,
            confirmSeed: row.game_seed,
            confirmHostTime: row.game_host_time,
            confirmerInRoster: frozen !== null && frozen.has(row.user_id),
            fingerprintAlreadyUsed,
        });
        if (!decision.ok) {
            log.info({ match_id: matchId, user_id: row.user_id, reason: decision.reason },
                'late reading refused');
            continue;
        }

        // CLAIM the row. Zero changes means another path already decided this match.
        const claim = await ctx.db.prepare(
            `UPDATE matches SET unrated_reason = NULL, rated = 1, decided_by = ?
             WHERE id = ? AND unrated_reason = 'no_decided_result'`,
        ).bind(row.user_id, matchId).run();
        if (!claim.changes) {
            log.info({ match_id: matchId }, 'late reading lost the race; already decided');
            return;
        }

        try {
            // The confirmer's own score, and its mirror for the other player — the same
            // 1 - x the launcher's resolver uses, so the two can never disagree about a
            // match, and the pair still sums to N/2 as POST /matches validates.
            //
            // Narrowed to 0 | 1 rather than cast: `row.result` is a REAL straight out of
            // SQLite, and a cast would quietly let a 0.5 through if that CHECK constraint
            // were ever relaxed. canUpgradeFromConfirmation has already refused anything
            // undecided, so collapsing to the two legal values here is honest, not lossy.
            const ownResult: 0 | 1 = row.result >= WIN_AT ? 1 : 0;
            const outcomes: ParticipantOutcome[] = players.map((id) => ({
                userId: id,
                result: id === row.user_id ? ownResult : ((1 - ownResult) as 0 | 1),
            }));

            const resultWrites = outcomes.map((o) => ctx.db.prepare(
                `UPDATE match_participants SET result = ? WHERE match_id = ? AND user_id = ?`,
            ).bind(o.result, matchId, o.userId));

            if (decision.adoptFingerprint) {
                // Gives the match the anti-duplicate protection it never had: a report with
                // no recording sends these as null, which is precisely the case being fixed.
                // The UNIQUE index is partial and can still collide with a row written since
                // the check above, so adopting is a bonus, not a requirement — on a clash the
                // decision stands and only the fingerprint is dropped.
                try {
                    await ctx.db.batch([
                        ...resultWrites,
                        ctx.db.prepare(
                            `UPDATE matches SET game_seed = ?, game_host_time = ? WHERE id = ?`,
                        ).bind(row.game_seed, row.game_host_time, matchId),
                    ]);
                } catch (err) {
                    log.info({ match_id: matchId, err: String(err) },
                        'fingerprint could not be adopted; deciding the match anyway');
                    await ctx.db.batch(resultWrites);
                }
            } else {
                await ctx.db.batch(resultWrites);
            }

            const diff = await applyMatch(ctx.db, outcomes);

            const stamps = [];
            for (const o of outcomes) {
                const d = diff.get(o.userId);
                if (!d) continue;
                stamps.push(ctx.db.prepare(
                    `UPDATE match_participants SET rating_before = ?, rating_after = ?
                     WHERE match_id = ? AND user_id = ?`,
                ).bind(d.before, d.after, matchId, o.userId));
            }
            if (stamps.length) await ctx.db.batch(stamps);

            log.info(
                { match_id: matchId, lobby_id: lobbyId, decided_by: row.user_id,
                  reason: decision.reason, adopted_fingerprint: decision.adoptFingerprint },
                'match decided by a late reading',
            );

            // The room closed minutes ago, so this is the only way either player learns it.
            ctx.globalChat.announceMatchRated({
                matchId,
                lobbyId,
                modId: match.mod_id,
                mapName: match.map_name,
                perUser: new Map(outcomes.map((o) => {
                    const d = diff.get(o.userId);
                    return [o.userId, { result: o.result, before: d?.before ?? null, after: d?.after ?? null }];
                })),
            });
        } catch (err) {
            // Put the row back rather than leave it marked rated with no ratings behind it —
            // and the PARTICIPANT scores with it. The result writes land before applyMatch, so
            // restoring only the match row would leave it reading "undecided" while its two
            // participant rows carried a winner: a contradiction, and one that would then be
            // shown in both players' History as a decided game nobody rated.
            //
            // 0.5 is the exact pre-upgrade state: the row was eligible precisely because
            // 'no_decided_result' means no participant was decided.
            await ctx.db.prepare(
                `UPDATE matches SET unrated_reason = 'no_decided_result', rated = 0, decided_by = NULL
                 WHERE id = ?`,
            ).bind(matchId).run();
            await ctx.db.prepare(
                `UPDATE match_participants SET result = 0.5, rating_before = NULL, rating_after = NULL
                 WHERE match_id = ?`,
            ).bind(matchId).run();
            log.error({ match_id: matchId, err: String(err) },
                'late reading failed to apply; match left undecided');
        }
        return;
    }
}

/**
 * Whether a team match has the reading from the OTHER side that lets it rate.
 *
 * <p>The I/O half of {@link teamEvidenceMet}. It recomputes `agreement` and `same_game`
 * in memory with exactly the rules `tieConfirmations` writes to the row, rather than
 * reading the stored columns — <b>because at report time they are not written yet</b>.
 * The player who just lost usually leaves first, so their confirmation routinely lands
 * before the match row exists, and `tieConfirmations` only runs once it does. Reading
 * the columns here would therefore report "no evidence" for precisely the ordering that
 * is most common.</p>
 *
 * <p>The stored columns remain the durable record; this is the same question asked a few
 * milliseconds earlier.</p>
 */
async function teamEvidenceForMatch(
    ctx: AppContext,
    lobbyId: string | null,
    participants: readonly { user_id: string; team: number; result: number }[],
    reporterUserId: string,
    fingerprint: GameFingerprint,
): Promise<boolean> {
    if (!lobbyId) return false;

    const teams = new Map(participants.map((p) => [p.user_id, p.team | 0] as [string, number]));
    const reported = new Map(participants.map((p) => [p.user_id, p.result] as [string, number]));

    const rows = await ctx.db.prepare(
        `SELECT user_id, result, game_seed FROM match_confirmations WHERE lobby_id = ?`,
    ).bind(lobbyId).all<{ user_id: string; result: number; game_seed: number | null }>();

    const confirmations = (rows.results ?? []).map((r) => {
        const reportedResult = reported.get(r.user_id);
        return {
            userId: r.user_id,
            agreement: reportedResult === undefined
                ? 'not_reported'
                : compareReadings(reportedResult, r.result),
            // Seed alone, the same rule tieConfirmations uses — both machines must
            // generate the same map, so they must share it.
            sameGame: fingerprint.seed === null || r.game_seed === null
                ? 'unknown'
                : String(fingerprint.seed === r.game_seed),
        };
    });

    return teamEvidenceMet({
        teams,
        reporterTeam: teams.get(reporterUserId) ?? null,
        confirmations,
    });
}

/**
 * Rate a team match that was stored waiting for the opposing side's reading, now that
 * one may have arrived.
 *
 * <p>The team counterpart of {@link maybeUpgradeFromConfirmation}, and deliberately a
 * separate function rather than a branch inside it: that one exists to DECIDE a match
 * nobody could read, and every clause in it is about trusting a single late reading. This
 * one decides nothing — the winner was already read and stored by the report — it only
 * releases a result that was always there once the corroboration rule is satisfied.</p>
 *
 * <p>Same two safety properties as its sibling. The row is CLAIMED with a conditional
 * update, so two callers racing cannot rate one match twice; and a failure puts the row
 * back rather than leaving it marked rated with no ratings behind it. It does NOT touch
 * `match_participants.result`, because unlike the late-reading path it never changes who
 * won.</p>
 */
async function maybeRateAwaitingTeamMatch(
    ctx: AppContext,
    log: FastifyBaseLogger,
    lobbyId: string,
    matchId: string,
): Promise<void> {
    const match = await ctx.db.prepare(
        `SELECT unrated_reason, rating_mode, game_seed, game_host_time,
                host_user_id, mod_id, map_name
         FROM matches WHERE id = ?`,
    ).bind(matchId).first<{
        unrated_reason: string | null;
        rating_mode: string | null;
        game_seed: number | null;
        game_host_time: number | null;
        host_user_id: string;
        mod_id: string;
        map_name: string | null;
    }>();
    if (!match || match.unrated_reason !== 'awaiting_confirmation') return;

    const rows = await ctx.db.prepare(
        `SELECT user_id, team, result FROM match_participants WHERE match_id = ?`,
    ).bind(matchId).all<{ user_id: string; team: number; result: number }>();
    const participants = rows.results ?? [];
    if (participants.length < 2) return;

    const met = await teamEvidenceForMatch(
        ctx, lobbyId, participants, match.host_user_id,
        { seed: match.game_seed, hostTime: match.game_host_time },
    );
    if (!met) return;

    const claim = await ctx.db.prepare(
        `UPDATE matches SET unrated_reason = NULL, rated = 1
         WHERE id = ? AND unrated_reason = 'awaiting_confirmation'`,
    ).bind(matchId).run();
    if (!claim.changes) {
        log.info({ match_id: matchId }, 'team match already rated by another path');
        return;
    }

    const mode: RatingMode = match.rating_mode === 'team' ? 'team' : 'default';

    try {
        const outcomes: ParticipantOutcome[] = participants.map((p) => ({
            userId: p.user_id,
            result: p.result as 0 | 0.5 | 1,
            team: p.team | 0,
        }));

        const diff = await applyMatch(ctx.db, outcomes, mode);

        const stamps = [];
        for (const o of outcomes) {
            const d = diff.get(o.userId);
            if (!d) continue;
            stamps.push(ctx.db.prepare(
                `UPDATE match_participants SET rating_before = ?, rating_after = ?
                 WHERE match_id = ? AND user_id = ?`,
            ).bind(d.before, d.after, matchId, o.userId));
        }
        if (stamps.length) await ctx.db.batch(stamps);

        log.info({ match_id: matchId, lobby_id: lobbyId, mode },
            'team match rated once both sides had read it');

        // The room closed when the host reported, so this is the only way anybody learns
        // the match ended up counting.
        ctx.globalChat.announceMatchRated({
            matchId,
            lobbyId,
            modId: match.mod_id,
            mapName: match.map_name,
            perUser: new Map(outcomes.map((o) => {
                const d = diff.get(o.userId);
                return [o.userId, { result: o.result, before: d?.before ?? null, after: d?.after ?? null }];
            })),
        });
    } catch (err) {
        // Back to waiting. The results are untouched by design, so only the rating state
        // has to be undone — and leaving it 'awaiting_confirmation' means a later
        // confirmation can try again, which is the right outcome for a transient failure.
        await ctx.db.prepare(
            `UPDATE matches SET unrated_reason = 'awaiting_confirmation', rated = 0 WHERE id = ?`,
        ).bind(matchId).run();
        await ctx.db.prepare(
            `UPDATE match_participants SET rating_before = NULL, rating_after = NULL
             WHERE match_id = ?`,
        ).bind(matchId).run();
        log.error({ match_id: matchId, err: String(err) },
            'team match failed to rate; left waiting');
    }
}

/**
 * Accept a fingerprint half only if it is a positive integer.
 *
 * <p>0 and absent mean the same thing — the recording did not carry it — and both
 * become null, because the unique index over the pair is partial. Storing zeroes
 * would make every recording that lacked a seed collide with every other one, and
 * honest matches would start reporting themselves as duplicates.</p>
 */
function normaliseFingerprint(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : null;
}

function normaliseSha256(value: string | undefined): string | null {
    const v = (value ?? '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(v) ? v : null;
}

/**
 * The I/O half of the abandonment rule; the decision itself is the pure
 * <c>decideByAbandon</c>. Never throws — a match must not fail to report because this
 * could not be answered.
 */
async function abandonVerdict(
    ctx: AppContext,
    lobbyId: string,
    participantIds: string[],
    roomStartedAtMs: number | null,
    reportHasRecording: boolean,
): Promise<ReturnType<typeof decideByAbandon>> {
    const rows = await ctx.db.prepare(
        `SELECT user_id, disconnected_at FROM lobby_abandons WHERE lobby_id = ?`,
    ).bind(lobbyId).all<{ user_id: string; disconnected_at: string }>();

    const abandons: Array<{ userId: string; disconnectedAtMs: number }> = [];
    for (const r of rows.results ?? []) {
        const ms = sqliteTimestampToMs(r.disconnected_at);
        if (ms !== null) abandons.push({ userId: r.user_id, disconnectedAtMs: ms });
    }

    // The widest anti-farm brake: real disconnections are rare and scattered, farming is
    // the same two accounts over and over. Derived from the constant rather than written
    // as SQLite's '-1 day' so there is one number, not two that can drift.
    let pairDecidedRecently = false;
    if (participantIds.length === 2) {
        const since = new Date(Date.now() - PAIR_COOLDOWN_MS)
            .toISOString().replace('T', ' ').slice(0, 19);
        const seen = await ctx.db.prepare(
            `SELECT 1 FROM matches m
               JOIN match_participants a ON a.match_id = m.id AND a.user_id = ?
               JOIN match_participants b ON b.match_id = m.id AND b.user_id = ?
              WHERE m.decided_by = 'abandon' AND m.created_at >= ?
              LIMIT 1`,
        ).bind(participantIds[0], participantIds[1], since).first();
        pairDecidedRecently = !!seen;
    }

    return decideByAbandon({
        participantIds,
        abandons,
        startedAtMs: roomStartedAtMs,
        nowMs: Date.now(),
        abandonAfterSeconds: ctx.config.competitiveAbandonSeconds,
        reportHasRecording,
        pairDecidedRecently,
    });
}

/**
 * Fill in WHO played each of these matches, and what each of them scored.
 *
 * A history row is the caller's OWN <c>match_participants</c> row joined to the match,
 * so on its own it can say "2 players" and never a name — which is the one thing a
 * history of games against real people most needs. Both halves were always in the
 * database and simply never joined: the names live in <c>users</c>, the win/loss in
 * <c>match_participants.result</c>.
 *
 * ONE extra query for the whole page, never one per match: fifty ids go into a single
 * IN and the rows are grouped here.
 */
export async function attachParticipants(
    ctx: AppContext,
    matches: Array<Record<string, unknown> & { id: string }>,
): Promise<void> {
    if (matches.length === 0) return;

    const ids = matches.map((m) => m.id);
    const parts = await ctx.db.prepare(
        `SELECT mp.match_id, mp.user_id, mp.team, mp.result,
                mp.rating_before, mp.rating_after,
                u.discord_username, u.display_name, u.avatar_url
         FROM match_participants mp
         -- INNER, and unlike the two LEFT JOINs on elo_ratings elsewhere in this codebase
         -- that is right here: match_participants.user_id is a FK to users(id) ON DELETE
         -- CASCADE, so a participant cannot outlive its user. A LEFT could only add a
         -- nameless row nothing could render.
         JOIN users u ON u.id = mp.user_id
         WHERE mp.match_id IN (${ids.map(() => '?').join(',')})
         -- Winner first. The tiebreaks are for the COMMON case, not an edge one: most
         -- stored matches are all-0.5 because the outcome could not be read, and without
         -- them those rosters come back in whatever order SQLite happens to produce,
         -- reshuffling the same match between two visits to the tab.
         ORDER BY mp.result DESC, mp.team, u.display_name`,
    ).bind(...ids).all<{
        match_id: string;
        user_id: string;
        team: number;
        result: number;
        rating_before: number | null;
        rating_after: number | null;
        discord_username: string;
        display_name: string;
        avatar_url: string | null;
    }>();

    const byMatch = new Map<string, unknown[]>();
    for (const p of parts.results ?? []) {
        let list = byMatch.get(p.match_id);
        if (!list) {
            list = [];
            byMatch.set(p.match_id, list);
        }
        // Same shape the rooms list already uses for a lobby host, so the launcher parses
        // one convention rather than a third one invented here.
        list.push({
            user_id: p.user_id,
            discord_username: p.discord_username,
            display_name: p.display_name,
            avatar_url: p.avatar_url,
            team: p.team,
            result: p.result,
            rating_before: p.rating_before,
            rating_after: p.rating_after,
        });
    }

    for (const m of matches) m.participants = byMatch.get(m.id) ?? [];
}

export function registerMatchesRest(app: FastifyInstance, ctx: AppContext): void {
    // POST /matches — host reports a finished game.
    app.post('/matches', {
        preHandler: [requireAuth(), ipRateLimit(ctx, Limits.LobbyCreateIp)],
    }, async (req, reply) => {
        const userId = req.userId!;
        const body = (req.body ?? null) as ReportMatchBody | null;
        if (!body) throw Errors.BadRequest('JSON body required');
        if (!Array.isArray(body.participants) || body.participants.length < 2) {
            throw Errors.BadRequest('participants[] must have ≥ 2 entries');
        }
        if (!body.mod_id || !body.mod_combined_hash) {
            throw Errors.BadRequest('mod_id and mod_combined_hash required');
        }
        if (!body.started_at || !body.ended_at) {
            throw Errors.BadRequest('started_at and ended_at required');
        }

        let rosterAtStart: string | null = null;
        // Read from the ROOM, never from the report: a client must not be able to promote
        // its own match into the ladder, and this row is already being fetched to validate
        // the reporter. Null when there was no room at all — see RatabilityInput.
        let roomIsCompetitive: boolean | null = null;
        let roomStartedAtMs: number | null = null;
        if (body.lobby_id) {
            const lobby = await ctx.db.prepare(
                `SELECT host_user_id, roster_at_start, competitive, started_at
                   FROM lobbies WHERE id = ?`,
            ).bind(body.lobby_id).first<{
                host_user_id: string;
                roster_at_start: string | null;
                competitive: number;
                started_at: string | null;
            }>();
            if (!lobby) throw Errors.NotFound('Lobby');
            // Whoever is host NOW. After a mid-match host migration that is the player the
            // server promoted, and letting them report is what stops a host dodging a loss
            // by closing his launcher — see the abandonment rule below.
            if (lobby.host_user_id !== userId) throw Errors.Forbidden();
            rosterAtStart = lobby.roster_at_start;
            roomIsCompetitive = lobby.competitive === 1;
            roomStartedAtMs = sqliteTimestampToMs(lobby.started_at);
        } else {
            const self = body.participants.find((p) => p.user_id === userId);
            if (!self) throw Errors.Forbidden();
        }

        // Every reported player must actually have been in the room when the game
        // started. Without this the only thing POST /matches checked was that the
        // REPORTER was the host — so a host could name any user id as the loser and
        // take their rating down for a game they never played.
        //
        // Against the roster frozen at Start, NOT against lobby_members: leaving a
        // room deletes that row, and the player most likely to leave first is the one
        // who just lost. Live membership would reject most real matches. The fallback
        // to lobby_members only covers a room that started before roster_at_start
        // existed — one deploy's worth of in-flight games, and it fails towards "not
        // rated", never towards rating something unverified.
        let allParticipantsInLobby = false;
        if (body.lobby_id) {
            const ids = new Set(body.participants.map((p) => p.user_id));
            const frozen = parseRoster(rosterAtStart);
            if (frozen !== null) {
                allParticipantsInLobby = [...ids].every((id) => frozen.has(id));
            } else {
                const list = [...ids];
                const placeholders = list.map(() => '?').join(',');
                const found = await ctx.db.prepare(
                    `SELECT COUNT(DISTINCT user_id) AS n FROM lobby_members
                     WHERE lobby_id = ? AND user_id IN (${placeholders})`,
                ).bind(body.lobby_id, ...list).first<{ n: number }>();
                allParticipantsInLobby = (found?.n ?? 0) === ids.size;
            }
        }

        // Asked BEFORE the insert rather than letting the unique index throw: the
        // insert runs inside a transaction with the participants, so a constraint
        // error would roll the whole match out of the history. A duplicate is stored
        // like any other match, just without the hash and without a rating.
        // (Two reports of the same file landing in the same millisecond would still
        // hit the index — that is what it is there for, and it cannot happen from one
        // launcher reporting one match.)
        const replaySha = normaliseSha256(body.replay_sha256);
        const gameSeed = normaliseFingerprint(body.game_seed);
        const gameHostTime = normaliseFingerprint(body.game_host_time);

        let duplicateRecording = false;
        if (replaySha !== null) {
            const seen = await ctx.db.prepare(
                `SELECT 1 FROM matches WHERE replay_sha256 = ? LIMIT 1`,
            ).bind(replaySha).first();
            duplicateRecording = !!seen;
        }
        // The stronger half of the same question. The hash identifies the FILE, so
        // re-packing a recording produces a new one and slips past; the seed and host
        // clock identify the GAME, and no amount of re-encoding changes those.
        if (!duplicateRecording && gameSeed !== null && gameHostTime !== null) {
            const seenGame = await ctx.db.prepare(
                `SELECT 1 FROM matches WHERE game_seed = ? AND game_host_time = ? LIMIT 1`,
            ).bind(gameSeed, gameHostTime).first();
            duplicateRecording = !!seenGame;
        }

        const matchId = uuid();
        const totalResult = body.participants.reduce((sum, p) => sum + p.result, 0);
        if (totalResult > body.participants.length / 2 + 0.001) {
            throw Errors.BadRequest('Results sum exceeds N/2 — invalid pattern');
        }

        const inserts = [
            ctx.db.prepare(
                `INSERT INTO matches (id, lobby_id, host_user_id, mod_id, mod_combined_hash,
                                      map_name, duration_seconds, started_at, ended_at,
                                      replay_sha256, game_seed, game_host_time)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
                matchId,
                body.lobby_id ?? null,
                userId,
                body.mod_id,
                body.mod_combined_hash,
                body.map_name ?? null,
                Math.max(0, body.duration_seconds | 0),
                body.started_at,
                body.ended_at,
                duplicateRecording ? null : replaySha,
                duplicateRecording ? null : gameSeed,
                duplicateRecording ? null : gameHostTime,
            ),
        ];
        for (const p of body.participants) {
            inserts.push(ctx.db.prepare(
                `INSERT INTO match_participants (match_id, user_id, team, civ, score, result)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            ).bind(matchId, p.user_id, p.team | 0, p.civ ?? null, p.score | 0, p.result));
        }
        await ctx.db.batch(inserts);

        // Decide ONCE whether this scores, and keep the reason: it goes back in the
        // response so the launcher can tell the player the truth without owning a
        // copy of the policy. A match that does not score is still stored above —
        // the history is a record of what was played, not of what was rated.
        let unratedReason: UnratedReason | null = ratabilityReason({
            modId: body.mod_id,
            rankedModIds: ctx.config.rankedModIds,
            participants: body.participants,
            hasLobby: !!body.lobby_id,
            roomIsCompetitive,
            allParticipantsInLobby,
            startedAt: body.started_at,
            endedAt: body.ended_at,
            durationSeconds: body.duration_seconds,
            nowMs: Date.now(),
        });
        if (unratedReason === null && replaySha !== null && duplicateRecording) {
            unratedReason = 'duplicate_recording';
        }

        // Which ladder this belongs to. Derived from the report's own shape, so it can
        // never disagree with the participants that are about to be rated; null here only
        // for a shape ratabilityReason already refused with `not_1v1`.
        const shape = matchShape(body.participants);
        const ratingMode: RatingMode = shape === 'team' ? 'team' : 'default';

        // A TEAM match is not rated on the reporter's word alone. His report is his own
        // side's reading; the ladder waits for one from the other side that agrees, on the
        // same game (`teamEvidenceMet`). Unlike every other reason this one is temporary —
        // POST /matches/confirm clears it when the witness arrives.
        //
        // Checked HERE as well as there because the order is not guaranteed: the player
        // who just lost usually leaves first, so their confirmation routinely lands before
        // the host has reported at all.
        if (unratedReason === null && shape === 'team') {
            const met = await teamEvidenceForMatch(
                ctx, body.lobby_id ?? null, body.participants, userId,
                { seed: gameSeed, hostTime: gameHostTime },
            );
            if (!met) unratedReason = 'awaiting_confirmation';
        }

        // Nobody won — but somebody may simply have walked out. This is the only rule in
        // the project that moves rating from an ABSENCE of evidence, so it is fenced in
        // hard: competitive rooms only, only when the recording could not answer (a
        // recording that names a winner always outranks an inference), and only through
        // the brakes in decideByAbandon. Best-effort: a failure here leaves the match
        // exactly as it was.
        let decidedBy: string | null = null;
        if (unratedReason === 'no_decided_result' && roomIsCompetitive && body.lobby_id) {
            try {
                const verdict = await abandonVerdict(
                    ctx,
                    body.lobby_id,
                    body.participants.map((p) => p.user_id),
                    roomStartedAtMs,
                    replaySha !== null || gameSeed !== null,
                );
                if (verdict.winnerId && verdict.loserId) {
                    // Rewrite the results in the parsed body, which is what feeds
                    // applyMatch AND the payload sent to both players — so the guest's
                    // end-of-match card shows the same outcome the ladder was given.
                    for (const part of body.participants) {
                        part.result = part.user_id === verdict.winnerId ? 1 : 0;
                    }
                    await ctx.db.batch(body.participants.map((part) => ctx.db.prepare(
                        `UPDATE match_participants SET result = ? WHERE match_id = ? AND user_id = ?`,
                    ).bind(part.result, matchId, part.user_id)));

                    unratedReason = null;
                    // A sentinel, not a user id: every other writer of this column stores
                    // the player whose late reading decided the match, and no user id can
                    // collide with this (they are uuids). It is what makes an abandonment
                    // findable afterwards — by `admin.ts`, and by anyone disputing one.
                    decidedBy = 'abandon';
                    req.log.info(
                        { match_id: matchId, winner: verdict.winnerId, loser: verdict.loserId },
                        'match decided by abandonment',
                    );
                } else {
                    req.log.info({ match_id: matchId, reason: verdict.reason },
                        'abandonment did not decide the match');
                }
            } catch (err) {
                req.log.info({ match_id: matchId, err: String(err) },
                    'abandonment check failed');
            }
        }

        let diff = new Map<string, { before: number; after: number; rdBefore: number; rdAfter: number }>();
        if (unratedReason === null) {
            const outcomes: ParticipantOutcome[] = body.participants.map((p) => ({
                userId: p.user_id,
                result: p.result,
                // Only for a real team shape. Sending `team` for a 1v1 would change
                // nothing (two players on different sides face each other either way),
                // but sending the 0 that every pre-team report carries would put both
                // players on the SAME side and skip the only pairing there is.
                team: shape === 'team' ? (p.team | 0) : undefined,
            }));
            diff = await applyMatch(ctx.db, outcomes, ratingMode);
        } else {
            req.log.info(
                { match_id: matchId, mod_id: body.mod_id, players: body.participants.length,
                  unrated_reason: unratedReason },
                'match stored but not rated',
            );
        }

        // Kept on the row, not only in the response. Until now the verdict was computed,
        // sent and logged but never stored, so a match that went down undecided could not be
        // re-examined later — the row did not remember it was waiting for an answer, which is
        // what made a correction impossible.
        //
        // Written AFTER the rating, not before: applyMatch can throw, and a row claiming
        // `rated = 1` with no ratings behind it is exactly the inconsistency the correction
        // path goes to some length to avoid creating.
        await ctx.db.prepare(
            `UPDATE matches SET unrated_reason = ?, rated = ?, decided_by = ?, rating_mode = ?
             WHERE id = ?`,
        ).bind(
            unratedReason, unratedReason === null ? 1 : 0, decidedBy,
            // Stored even when the match did not rate, and that is deliberate: a row
            // waiting on a confirmation has to remember which ladder it is waiting FOR,
            // or the upgrade below would have to guess.
            ratingMode, matchId,
        ).run();

        const updates = [];
        for (const p of body.participants) {
            const d = diff.get(p.user_id);
            if (!d) continue;
            updates.push(ctx.db.prepare(
                `UPDATE match_participants SET rating_before = ?, rating_after = ?
                 WHERE match_id = ? AND user_id = ?`,
            ).bind(d.before, d.after, matchId, p.user_id));
        }
        if (updates.length) await ctx.db.batch(updates);

        // Built once and sent twice: to the room over the socket, and back to the
        // host in the response. The per-participant RESULT is the load-bearing part
        // and not just the ratings — the guest has no recording of their own, so
        // without it their end-of-match card could only say "no result" even when
        // they had won.
        const participantsPayload = body.participants.map((p) => {
            const d = diff.get(p.user_id);
            return {
                user_id: p.user_id,
                result: p.result,
                rating_before: d?.before ?? null,
                rating_after: d?.after ?? null,
            };
        });

        if (body.lobby_id) {
            // Evidence only, and deliberately AFTER everything that matters: the match
            // is inserted and rated by now, so a failure in here cannot cost the report.
            try {
                await tieConfirmations(
                    ctx, req.log, body.lobby_id, matchId,
                    new Map(body.participants.map((p) => [p.user_id, p.result as number] as [string, number])),
                    { seed: gameSeed, hostTime: gameHostTime },
                );
            } catch (err) {
                req.log.info({ match_id: matchId, err: String(err) },
                    'confirmations could not be tied');
            }

            // The guest routinely leaves before the host, so their reading is often already
            // waiting here when the report lands. If this match went down undecided and one
            // of them can decide it, do it now rather than leaving it unrated forever.
            //
            // The response has already been built from `diff`, so a correction made here is
            // NOT in it — which is correct: the host's own card shows what their report said,
            // and the announcement inside handles telling both players about the change.
            try {
                await maybeUpgradeFromConfirmation(ctx, req.log, body.lobby_id, matchId);
            } catch (err) {
                req.log.info({ match_id: matchId, err: String(err) },
                    'late reading could not be applied');
            }

            // The team counterpart: this match may have gone down 'awaiting_confirmation'
            // a moment ago while the opposing side's reading was ALREADY on file — the
            // usual ordering, since the losing side leaves first. tieConfirmations has
            // just run, so by now the evidence is written down as well as computable.
            try {
                await maybeRateAwaitingTeamMatch(ctx, req.log, body.lobby_id, matchId);
            } catch (err) {
                req.log.info({ match_id: matchId, err: String(err) },
                    'team match could not be rated');
            }

            await ctx.db.prepare(
                `UPDATE lobbies SET status = 'closed', closed_at = datetime('now') WHERE id = ?`,
            ).bind(body.lobby_id).run();

            // BEFORE the close, and the order is load-bearing: closing the sockets is
            // how the room used to end, which left the guest with nothing but three
            // polls of the match history to discover whether they had won. The `ws`
            // library queues the close frame behind data already queued on the same
            // sender, so this arrives first.
            ctx.rooms.publish(body.lobby_id, {
                type: 'match_reported',
                match_id: matchId,
                lobby_id: body.lobby_id,
                map_name: body.map_name ?? null,
                duration_seconds: Math.max(0, body.duration_seconds | 0),
                rated: unratedReason === null,
                unrated_reason: unratedReason,
                participants: participantsPayload,
            });

            ctx.rooms.close(body.lobby_id, 4007, 'match_reported');
            finalizeRoom(body.lobby_id);
        }

        return reply.send({
            match_id: matchId,
            rated: unratedReason === null,
            unrated_reason: unratedReason,
            rating_changes: participantsPayload,
        });
    });

    // POST /matches/confirm — the OTHER player's own reading of a match.
    //
    // Reporting stays host-only (N reporters would insert N copies of one match), so
    // this is a separate, smaller thing: a second opinion, stored and compared, that
    // changes nothing about whether the match scores. See the migration for why.
    app.post('/matches/confirm', {
        preHandler: [requireAuth(), ipRateLimit(ctx, Limits.LobbyCreateIp)],
    }, async (req, reply) => {
        const userId = req.userId!;
        const body = (req.body ?? null) as {
            lobby_id?: string;
            result?: number;
            replay_sha256?: string;
            game_seed?: number | null;
            game_host_time?: number | null;
        } | null;
        if (!body?.lobby_id) throw Errors.BadRequest('lobby_id required');

        const result = typeof body.result === 'number' ? body.result : 0.5;
        if (result !== 0 && result !== 0.5 && result !== 1) {
            throw Errors.BadRequest('result must be 0, 0.5 or 1');
        }

        const lobby = await ctx.db.prepare(
            `SELECT roster_at_start FROM lobbies WHERE id = ?`,
        ).bind(body.lobby_id).first<{ roster_at_start: string | null }>();
        if (!lobby) throw Errors.NotFound('Lobby');

        // Checked against the roster frozen at Start, for exactly the reason the report
        // is: leaving a room DELETES the lobby_members row, and the player sending this
        // is usually the first one out. A room with no frozen roster predates the column
        // and cannot be checked, so it is refused rather than trusted.
        const roster = parseRoster(lobby.roster_at_start);
        if (roster === null || !roster.has(userId)) throw Errors.Forbidden();

        await ctx.db.prepare(
            `INSERT INTO match_confirmations
                 (lobby_id, user_id, result, replay_sha256, game_seed, game_host_time)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (lobby_id, user_id) DO UPDATE SET
               result = excluded.result,
               replay_sha256 = excluded.replay_sha256,
               game_seed = excluded.game_seed,
               game_host_time = excluded.game_host_time,
               created_at = datetime('now')`,
        ).bind(
            body.lobby_id, userId, result,
            normaliseSha256(body.replay_sha256),
            normaliseFingerprint(body.game_seed),
            normaliseFingerprint(body.game_host_time),
        ).run();

        // If the host already reported, compare now; otherwise the report will, when it
        // arrives. Either order works, which is the point of keying by lobby.
        const match = await ctx.db.prepare(
            `SELECT id, game_seed, game_host_time FROM matches
             WHERE lobby_id = ? ORDER BY created_at DESC LIMIT 1`,
        ).bind(body.lobby_id).first<{
            id: string; game_seed: number | null; game_host_time: number | null;
        }>();

        if (match) {
            const reported = await ctx.db.prepare(
                `SELECT user_id, result FROM match_participants WHERE match_id = ?`,
            ).bind(match.id).all<{ user_id: string; result: number }>();
            try {
                await tieConfirmations(
                    ctx, req.log, body.lobby_id, match.id,
                    new Map((reported.results ?? []).map((r) => [r.user_id, r.result] as [string, number])),
                    { seed: match.game_seed, hostTime: match.game_host_time },
                );
            } catch (err) {
                req.log.info({ lobby_id: body.lobby_id, err: String(err) },
                    'confirmations could not be tied');
            }

            // The other direction: the report is already in, and THIS reading may be the one
            // that can decide it. Same guard, same rule — the row is only eligible while it
            // says 'no_decided_result', so this can never overturn a decided match.
            // A team match stored waiting for exactly this reading.
            try {
                await maybeRateAwaitingTeamMatch(ctx, req.log, body.lobby_id, match.id);
            } catch (err) {
                req.log.info({ match_id: match.id, err: String(err) },
                    'team match could not be rated');
            }

            try {
                await maybeUpgradeFromConfirmation(ctx, req.log, body.lobby_id, match.id);
            } catch (err) {
                req.log.info({ lobby_id: body.lobby_id, err: String(err) },
                    'late reading could not be applied');
            }
        }

        return reply.send({ ok: true, matched: !!match });
    });

    app.get('/matches/history/:userId', {
        preHandler: [ipRateLimit(ctx, Limits.StatsIp)],
    }, async (req, reply) => {
        const userId = (req.params as { userId: string }).userId;
        const rows = await ctx.db.prepare(
            // m.rated / m.unrated_reason are stored columns (migration 0006) that this
            // endpoint simply never selected, so a history row could show that a match did
            // not count but never why — and the launcher's card was left inferring "nobody
            // recorded it", which is right for the common case and wrong for a team game, a
            // non-competitive room or a mod with no ladder. The reason it now carries maps
            // straight onto the explanations the end-of-match card already has.
            //
            // NULL on both means a row written before that migration: "we don't know",
            // which is not the same as "it counted", and the client treats it that way.
            `SELECT m.id, m.mod_id, m.map_name, m.duration_seconds, m.started_at, m.ended_at,
                    m.replay_object_key, m.rated, m.unrated_reason,
                    mp.team, mp.civ, mp.score, mp.result,
                    mp.rating_before, mp.rating_after,
                    (SELECT COUNT(*) FROM match_participants WHERE match_id = m.id) AS player_count
             FROM match_participants mp
             JOIN matches m ON m.id = mp.match_id
             WHERE mp.user_id = ?
             ORDER BY m.started_at DESC
             LIMIT 50`,
        ).bind(userId).all<Record<string, unknown> & { id: string }>();

        // `rated` is coerced to a real boolean here, and this is not cosmetic: SQLite has no
        // boolean type, the column is INTEGER, and better-sqlite3 hands it back as a JS number.
        // Sent raw it goes out as `1`, and a client that declares the field a boolean cannot
        // bind it — System.Text.Json throws, the exception aborts the WHOLE array, and one row
        // takes the entire history page down. That is exactly what shipped in launcher 1.0.13l:
        // the page sat on "Loading..." for ever.
        //
        // NULL is PRESERVED rather than folded into false. A row from before migration 0006 has
        // no answer, and "we don't know" is not "it did not count" — flattening it would make
        // every old match claim it was unrated.
        const matches = (rows.results ?? []).map((m) => ({
            ...m,
            rated: m.rated == null ? null : Boolean(m.rated),
        }));
        await attachParticipants(ctx, matches);
        return reply.send({ matches });
    });

    app.get('/matches/elo/:userId', {
        preHandler: [ipRateLimit(ctx, Limits.StatsIp)],
    }, async (req, reply) => {
        const userId = (req.params as { userId: string }).userId;
        const row = await ctx.db.prepare(
            `SELECT rating, rd, volatility, games_played, updated_at
             FROM elo_ratings WHERE user_id = ? AND mode = 'default'`,
        ).bind(userId).first<{
            rating: number;
            rd: number;
            volatility: number;
            games_played: number;
            updated_at: string;
        }>();

        // Decided games only. A result of 0.5 means the outcome could not be read —
        // no recording, a team game, a skirmish, or any match reported before the
        // launcher could read one — so it is counted as neither a win nor a loss.
        // Most stored rows are 0.5, which is why the client must divide by wins+losses
        // and not by games_played: doing the latter would report "3% wins" for someone
        // who won 3 of their 4 decided games.
        const tally = await ctx.db.prepare(
            `SELECT SUM(CASE WHEN result >= 0.999 THEN 1 ELSE 0 END) AS wins,
                    SUM(CASE WHEN result <= 0.001 THEN 1 ELSE 0 END) AS losses
             FROM match_participants WHERE user_id = ?`,
        ).bind(userId).first<{ wins: number | null; losses: number | null }>();

        // SUM() over no rows is NULL, not 0.
        const wins = tally?.wins ?? 0;
        const losses = tally?.losses ?? 0;

        // No row: unrated, which is the starting rating. This endpoint always answered
        // that way — it is where the chip's 1500 comes from — while the rooms list, the
        // presence frame and the room roster sent null for the same player. Same
        // constants everywhere now, so they cannot drift apart again.
        if (!row) return reply.send({
            rating: DEFAULT_RATING, rd: DEFAULT_RD, volatility: DEFAULT_VOLATILITY,
            games_played: 0, wins, losses,
        });
        return reply.send({ ...row, wins, losses });
    });
}
