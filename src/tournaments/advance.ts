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
 * The three call sites, and why all three are needed
 * ---------------------------------------------------------------------------
 * A match can be decided at three different moments, and the bracket has to follow at
 * each of them:
 *
 *  1. `POST /matches` — the host's report, the normal case.
 *  2. `maybeUpgradeFromConfirmation` — a 1v1 that went down `no_decided_result` and is
 *     settled minutes later by the other player's reading, with the room long closed.
 *  3. `maybeRateAwaitingTeamMatch` — **a team match, which is not rated on the reporter's
 *     word at all.** It sits `awaiting_confirmation` until somebody on the OTHER side
 *     agrees. Without this third call no team tournament would ever finish a round.
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
import { advance } from './bracket';
import * as store from './store';

/** A win and a loss as the stored `result` encodes them. Mirrors elo/ratability. */
const WIN_AT = 0.999;
const LOSS_AT = 0.001;

interface ParticipantRow {
    user_id: string;
    result: number;
}

export interface AdvanceOutcome {
    tournamentId: string;
    tournamentMatchId: string;
    winnerEntrantId: string;
    /** Everyone on either side, so the caller can push to exactly them. */
    notify: string[];
    tournamentDone: boolean;
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

    const { tournamentId, tournamentMatchId } = link;

    const bracket = await store.loadBracket(ctx.db, tournamentId);
    const target = bracket.find((m) => m.id === tournamentMatchId);
    if (!target) {
        log.info({ match_id: matchId, tournament_match_id: tournamentMatchId },
            'tournament match vanished; not advancing');
        return null;
    }
    // Already settled — by a resent report, by the owner, or by the other decide path.
    if (target.status !== 'pending') return null;
    if (!target.entrant1Id || !target.entrant2Id) {
        log.info({ tournament_match_id: tournamentMatchId },
            'tournament match is missing an entrant; not advancing');
        return null;
    }

    const parts = await ctx.db.prepare(
        `SELECT user_id, result FROM match_participants WHERE match_id = ?`,
    ).bind(matchId).all<ParticipantRow>();
    const participants = parts.results ?? [];
    if (participants.length < 2) return null;

    // A 0.5 is "could not be read", NEVER a draw. An undecided game leaves the bracket
    // match pending and the room can be opened again — which is the whole reason the
    // decide-later paths call this function too.
    const winners = participants.filter((p) => p.result >= WIN_AT).map((p) => p.user_id);
    const losers = participants.filter((p) => p.result <= LOSS_AT).map((p) => p.user_id);
    if (winners.length === 0 || losers.length === 0) return null;
    if (winners.length + losers.length !== participants.length) return null;

    // Map the players to the two sides of the bracket through the FROZEN rosters. A live
    // team lookup would let a roster change made after registration decide a match.
    const rosters = await store.loadRosters(ctx.db, tournamentId);
    const side1 = new Set(rosters.get(target.entrant1Id) ?? []);
    const side2 = new Set(rosters.get(target.entrant2Id) ?? []);

    const winnerEntrantId = sideOf(winners, side1, side2, target.entrant1Id, target.entrant2Id);
    const loserEntrantId = sideOf(losers, side1, side2, target.entrant1Id, target.entrant2Id);

    if (!winnerEntrantId || !loserEntrantId || winnerEntrantId === loserEntrantId) {
        // Somebody in the report is on neither registered side, or both sides map to one
        // entrant. Either way this is not the match the bracket thinks it is, and guessing
        // would put the wrong name in a round.
        log.info(
            { match_id: matchId, tournament_match_id: tournamentMatchId },
            'reported players do not line up with the bracket entrants; not advancing',
        );
        return null;
    }

    // Advancement keys off a DECIDED result, not off `rated`. A game the ladder refused for
    // `duplicate_recording` or `implausible_timing` still names a winner, and the owner has
    // a walkover if they disagree. Tying the bracket to `rated` would strand a round on a
    // technicality nobody in it can fix.
    const disqualified = await disqualifiedSet(ctx, tournamentId);
    const result = advance(bracket, tournamentMatchId, winnerEntrantId, 'played', disqualified);
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
        ctx.db, tournamentMatchId, winnerEntrantId, 'played', winners[0]!, matchId);
    if (!claimed) {
        log.info({ tournament_match_id: tournamentMatchId }, 'lost the race; already decided');
        return null;
    }

    await store.recordMatchGame(ctx.db, tournamentMatchId, matchId, winnerEntrantId);
    // The claim above already wrote this match's own row, so only the downstream changes
    // are left — writing it again would be harmless but would overwrite `decided_by`.
    await store.applyMatchUpdates(ctx.db, result.updates.filter((u) => u.id !== tournamentMatchId));
    await store.touch(ctx.db, tournamentId);

    if (result.tournamentDone) {
        await store.finishTournament(ctx.db, tournamentId, result.championEntrantId);
    }

    log.info(
        { match_id: matchId, tournament_id: tournamentId, tournament_match_id: tournamentMatchId,
          winner_entrant_id: winnerEntrantId, done: result.tournamentDone },
        'bracket advanced',
    );

    return {
        tournamentId,
        tournamentMatchId,
        winnerEntrantId,
        notify: [...side1, ...side2],
        tournamentDone: result.tournamentDone,
    };
}

/** Which entrant a set of players belongs to, or null if they are not all on one side. */
function sideOf(
    userIds: readonly string[],
    side1: ReadonlySet<string>,
    side2: ReadonlySet<string>,
    entrant1Id: string,
    entrant2Id: string,
): string | null {
    if (userIds.length === 0) return null;
    if (userIds.every((u) => side1.has(u))) return entrant1Id;
    if (userIds.every((u) => side2.has(u))) return entrant2Id;
    return null;
}

async function disqualifiedSet(ctx: AppContext, tournamentId: string): Promise<Set<string>> {
    const rows = await store.listEntrants(ctx.db, tournamentId);
    return new Set(rows.filter((e) => e.status === 'disqualified').map((e) => e.id));
}
