import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { Errors } from '../lib/errors';
import { uuid } from '../lib/ids';
import { requireAuth } from '../middleware/auth';
import { ipRateLimit, Limits } from '../middleware/rateLimit';
import { applyMatch, type ParticipantOutcome } from '../elo/glicko2';
import { ratabilityReason, compareReadings,
         type UnratedReason } from '../elo/ratability';
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

        await ctx.db.prepare(
            `UPDATE match_confirmations SET match_id = ? WHERE lobby_id = ? AND user_id = ?`,
        ).bind(matchId, lobbyId, row.user_id).run();

        // Were the two of them even reading the same GAME? Decided on the seed alone:
        // both machines must generate the same map, so they must share it. The host
        // clock is recorded beside it but deliberately does NOT take part in the
        // verdict — only one side of a match was ever available to measure, so whether
        // the guest's recording carries the same value is plausible and unproven. When
        // the two-machine test settles it, this is the line that promotes it.
        const sameGame = fingerprint.seed === null || row.game_seed === null
            ? 'unknown'
            : fingerprint.seed === row.game_seed;
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
        if (body.lobby_id) {
            const lobby = await ctx.db.prepare(
                `SELECT host_user_id, roster_at_start FROM lobbies WHERE id = ?`,
            ).bind(body.lobby_id).first<{ host_user_id: string; roster_at_start: string | null }>();
            if (!lobby) throw Errors.NotFound('Lobby');
            if (lobby.host_user_id !== userId) throw Errors.Forbidden();
            rosterAtStart = lobby.roster_at_start;
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
            allParticipantsInLobby,
            startedAt: body.started_at,
            endedAt: body.ended_at,
            durationSeconds: body.duration_seconds,
            nowMs: Date.now(),
        });
        if (unratedReason === null && replaySha !== null && duplicateRecording) {
            unratedReason = 'duplicate_recording';
        }

        let diff = new Map<string, { before: number; after: number; rdBefore: number; rdAfter: number }>();
        if (unratedReason === null) {
            const outcomes: ParticipantOutcome[] = body.participants.map((p) => ({
                userId: p.user_id,
                result: p.result,
            }));
            diff = await applyMatch(ctx.db, outcomes);
        } else {
            req.log.info(
                { match_id: matchId, mod_id: body.mod_id, players: body.participants.length,
                  unrated_reason: unratedReason },
                'match stored but not rated',
            );
        }

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
        }

        return reply.send({ ok: true, matched: !!match });
    });

    app.get('/matches/history/:userId', {
        preHandler: [ipRateLimit(ctx, Limits.StatsIp)],
    }, async (req, reply) => {
        const userId = (req.params as { userId: string }).userId;
        const rows = await ctx.db.prepare(
            `SELECT m.id, m.mod_id, m.map_name, m.duration_seconds, m.started_at, m.ended_at,
                    m.replay_object_key, mp.team, mp.civ, mp.score, mp.result,
                    mp.rating_before, mp.rating_after,
                    (SELECT COUNT(*) FROM match_participants WHERE match_id = m.id) AS player_count
             FROM match_participants mp
             JOIN matches m ON m.id = mp.match_id
             WHERE mp.user_id = ?
             ORDER BY m.started_at DESC
             LIMIT 50`,
        ).bind(userId).all();
        return reply.send({ matches: rows.results ?? [] });
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

        if (!row) return reply.send({
            rating: 1500, rd: 350, volatility: 0.06, games_played: 0, wins, losses,
        });
        return reply.send({ ...row, wins, losses });
    });
}
