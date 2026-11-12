/**
 * Whether a team match has the reading from the OTHER side that lets it count.
 *
 * <p>The I/O half of {@link teamEvidenceMet}, moved out of `matches/rest.ts` so the BRACKET can
 * ask the same question the ladder asks (src/tournaments/advance.ts) — a team tournament match
 * moves its bracket on exactly the evidence that rates it, never on the reporter's word alone.
 * Two copies of this would be two answers to one question.</p>
 *
 * <p>It recomputes `agreement` and `same_game` in memory with exactly the rules
 * `tieConfirmations` writes to the row, rather than reading the stored columns — <b>because at
 * report time they are not written yet</b>. The player who just lost usually leaves first, so
 * their confirmation routinely lands before the match row exists, and `tieConfirmations` only
 * runs once it does. Reading the columns here would therefore report "no evidence" for
 * precisely the ordering that is most common.</p>
 *
 * <p>The stored columns remain the durable record; this is the same question asked a few
 * milliseconds earlier.</p>
 */
import { compareReadings, teamEvidenceMet } from '../elo/ratability';
import type { AppContext } from '../context';

/** The match's own fingerprint, to compare a confirmation against. */
export interface GameFingerprint {
    seed: number | null;
    hostTime: number | null;
}

export async function teamEvidenceForMatch(
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
