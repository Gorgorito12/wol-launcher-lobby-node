/**
 * Moving a bracket forward when a real game decides one of its matches.
 *
 * ---------------------------------------------------------------------------
 * Where the tournament comes from
 * ---------------------------------------------------------------------------
 * From the LOBBY row, never from the report body. `lobbies.tournament_match_id` was
 * written by the tournament route before anybody played, which is the same rule as
 * `lobbies.competitive` and for the same reason: the client is what an attacker controls,
 * and a report that could claim "this was a tournament match" would let anybody advance
 * any bracket with a game they made up.
 *
 * ---------------------------------------------------------------------------
 * What decides it — src/tournaments/reportVerdict.ts
 * ---------------------------------------------------------------------------
 * The winners must be exactly one entrant's frozen line-up and the losers the other's. A
 * 1v1 then advances on a decided result, rated or not. A TEAM match advances only once the
 * OTHER side has corroborated it — the evidence that rates it (`teamEvidenceForMatch`) —
 * and never when it was played with other sides than the room's (`teams_mismatch`).
 *
 * ---------------------------------------------------------------------------
 * The call sites, and why each is needed
 * ---------------------------------------------------------------------------
 * A match can be decided at several moments, and the bracket follows at each of them
 * (all through `maybeAdvanceTournament` in matches/rest.ts):
 *
 *  - `POST /matches` — the host's report. Decides every 1v1, and a team match whose other
 *    side had ALREADY confirmed (the usual order: the losing side leaves first).
 *  - `maybeRateAwaitingTeamMatch` — **a team match released by the other side's reading.**
 *    This is where most team brackets move.
 *  - the tail of `POST /matches/confirm` — a team match the ladder refused for another
 *    reason (so it never waited `awaiting_confirmation`) whose witness arrives later.
 *  - `maybeUpgradeFromConfirmation` and the two abandonment paths — 1v1s decided late.
 *
 * Calling it more than once for the same match is harmless and expected: the conditional
 * claim in `claimMatchResult` makes every call after the first a no-op.
 *
 * ---------------------------------------------------------------------------
 * Best-effort, always
 * ---------------------------------------------------------------------------
 * Every call site wraps this in a try/catch that only logs. By the time it runs the match
 * is stored and rated, so a failure here must cost the report nothing — the same placement
 * philosophy as `tieConfirmations`. A bracket that did not advance can be pushed along by
 * the owner with a walkover, or by the maintainer's CLI.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context';
import { advance, type BracketMatch } from './bracket';
import { decideReport, type ReportVerdict } from './reportVerdict';
import { teamEvidenceForMatch } from '../matches/teamEvidence';
import type { TournamentFormat } from './entrants';
import * as store from './store';
import { invalidateTournament } from './cache';

export interface AdvanceOutcome {
    tournamentId: string;
    tournamentMatchId: string;
    winnerEntrantId: string;
    /** Everyone on either side, so the caller can push to exactly them. */
    notify: string[];
    tournamentDone: boolean;
}

interface StoredMatch {
    lobby_id: string | null;
    host_user_id: string;
    unrated_reason: string | null;
    game_seed: number | null;
    game_host_time: number | null;
}

/**
 * The verdict of one stored match on one bracket slot. Read-only: used by the advance below
 * and by the tournament detail, which shows WHY a played slot has not moved
 * (`pending_report`).
 */
export async function reportVerdictFor(
    ctx: AppContext,
    matchId: string,
    format: TournamentFormat,
    target: Pick<BracketMatch, 'entrant1Id' | 'entrant2Id'>,
    rosters: ReadonlyMap<string, readonly string[]>,
): Promise<ReportVerdict | null> {
    if (!target.entrant1Id || !target.entrant2Id) return null;

    const match = await ctx.db.prepare(
        `SELECT lobby_id, host_user_id, unrated_reason, game_seed, game_host_time
           FROM matches WHERE id = ?`,
    ).bind(matchId).first<StoredMatch>();
    if (!match) return null;

    const parts = await ctx.db.prepare(
        `SELECT user_id, team, result FROM match_participants WHERE match_id = ?`,
    ).bind(matchId).all<{ user_id: string; team: number; result: number }>();
    const participants = parts.results ?? [];
    if (participants.length < 2) return null;

    // Only a team match needs the other side's reading, and only then is it worth a query.
    const corroborated = format === '1v1' ? false : await teamEvidenceForMatch(
        ctx, match.lobby_id, participants, match.host_user_id,
        { seed: match.game_seed, hostTime: match.game_host_time });

    return decideReport({
        format,
        entrant1: { id: target.entrant1Id, members: rosters.get(target.entrant1Id) ?? [] },
        entrant2: { id: target.entrant2Id, members: rosters.get(target.entrant2Id) ?? [] },
        participants,
        unratedReason: match.unrated_reason,
        corroborated,
    });
}

/**
 * Advance the bracket this match belongs to, if it belongs to one.
 *
 * Returns who should be told, so the caller can push. The push is not done here: this
 * module knows about rows, not sockets.
 */
export async function advanceTournamentFromMatch(
    ctx: AppContext,
    log: FastifyBaseLogger,
    matchId: string,
): Promise<AdvanceOutcome | null> {
    const link = await store.findTournamentMatchForLobby(ctx.db, matchId);
    if (!link) return null;

    // Whatever this decides, the tournament's detail must be read afresh: a report changes
    // what the slot says (`pending_report`) even when it does not move it, and a move changes
    // the bracket. Without this the players were pushed "you won" while the bracket they
    // opened still showed the match undecided, for up to a minute.
    try {
        return await advanceLinked(ctx, log, matchId, link);
    } finally {
        invalidateTournament(link.tournamentId);
    }
}

async function advanceLinked(
    ctx: AppContext,
    log: FastifyBaseLogger,
    matchId: string,
    link: { tournamentId: string; tournamentMatchId: string },
): Promise<AdvanceOutcome | null> {
    const { tournamentId, tournamentMatchId } = link;

    const tournament = await store.getTournament(ctx.db, tournamentId);
    if (!tournament) return null;

    const bracket = await store.loadBracket(ctx.db, tournamentId);
    const target = bracket.find((m) => m.id === tournamentMatchId);
    if (!target) {
        log.info({ match_id: matchId, tournament_match_id: tournamentMatchId },
            'tournament match vanished; not advancing');
        return null;
    }
    // Already settled — by a resent report, by the owner, or by another decide path.
    if (target.status !== 'pending') return null;
    if (!target.entrant1Id || !target.entrant2Id) {
        log.info({ tournament_match_id: tournamentMatchId },
            'tournament match is missing an entrant; not advancing');
        return null;
    }

    // The players are mapped to the two sides through the FROZEN rosters. A live team
    // lookup would let a roster change made after registration decide a match.
    const rosters = await store.loadRosters(ctx.db, tournamentId);
    const verdict = await reportVerdictFor(ctx, matchId, tournament.format, target, rosters);
    if (!verdict) return null;
    if (verdict.kind !== 'advance') {
        log.info(
            { match_id: matchId, tournament_match_id: tournamentMatchId,
              verdict: verdict.kind, reason: verdict.reason },
            verdict.kind === 'wait'
                ? 'team result not corroborated by the other side yet; bracket waits'
                : 'report does not decide this bracket slot; not advancing',
        );
        return null;
    }

    const disqualified = await disqualifiedSet(ctx, tournamentId);
    const result = advance(bracket, tournamentMatchId, verdict.winnerEntrantId, 'played', disqualified);
    if (!result.ok) {
        log.info({ tournament_match_id: tournamentMatchId, reason: result.reason },
            'bracket refused the result');
        return null;
    }

    // CLAIM the row before touching anything else, exactly as the late-reading path claims
    // a match. Zero changes means another call got here first — a resent report, or the
    // host's report racing a confirmation — and advancing twice would seat one winner in
    // two rounds.
    const claimed = await store.claimMatchResult(
        ctx.db, tournamentMatchId, verdict.winnerEntrantId, 'played', verdict.winners[0]!, matchId);
    if (!claimed) {
        log.info({ tournament_match_id: tournamentMatchId }, 'lost the race; already decided');
        return null;
    }

    await store.recordMatchGame(ctx.db, tournamentMatchId, matchId, verdict.winnerEntrantId);
    // The claim above already wrote this match's own row, so only the downstream changes
    // are left — writing it again would be harmless but would overwrite `decided_by`.
    await store.applyMatchUpdates(ctx.db, result.updates.filter((u) => u.id !== tournamentMatchId));
    await store.touch(ctx.db, tournamentId);

    if (result.tournamentDone) {
        await store.finishTournament(ctx.db, tournamentId, result.championEntrantId);
    }

    log.info(
        { match_id: matchId, tournament_id: tournamentId, tournament_match_id: tournamentMatchId,
          winner_entrant_id: verdict.winnerEntrantId, done: result.tournamentDone },
        'bracket advanced',
    );

    const side1 = rosters.get(target.entrant1Id) ?? [];
    const side2 = rosters.get(target.entrant2Id) ?? [];
    return {
        tournamentId,
        tournamentMatchId,
        winnerEntrantId: verdict.winnerEntrantId,
        notify: [...side1, ...side2],
        tournamentDone: result.tournamentDone,
    };
}

async function disqualifiedSet(ctx: AppContext, tournamentId: string): Promise<Set<string>> {
    const rows = await store.listEntrants(ctx.db, tournamentId);
    return new Set(rows.filter((e) => e.status === 'disqualified').map((e) => e.id));
}
