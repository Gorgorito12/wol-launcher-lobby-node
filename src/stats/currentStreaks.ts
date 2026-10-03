/**
 * The CURRENT win streak of every player on a ladder page (design 55a: the 🔥 pill beside a name,
 * from 3 wins in a row). One query for the whole page, never one per row — the same rule
 * `topCivsSql` follows.
 *
 * <p>Only the latest {@link STREAK_LOOKBACK} rated matches of each player are read: a current
 * streak is the run that ENDS at the latest match, so nothing older can change it unless the run
 * itself is longer than the look-back, in which case the pill says {@link STREAK_LOOKBACK}. The
 * profile's own streak (`standingFor`) reads every match and is exact.</p>
 *
 * <p>The rules are {@link streakSummary}'s, so the table and the profile cannot disagree about
 * what a streak is: broken by a loss or a draw, and by fourteen days without a rated match.</p>
 */
import type { RatingMode } from '../elo/glicko2';
import { streakSummary } from '../elo/streaks';
import { sqliteTimestampToMs } from '../lib/time';
import type { AppContext } from '../context';

/** How many recent rated matches per player the table reads. */
export const STREAK_LOOKBACK = 60;

/** The query: per player, the latest rated matches of one mode, oldest first. */
export function recentResultsSql(players: number): string {
    const marks = Array.from({ length: players }, () => '?').join(', ');
    return `SELECT user_id, created_at, result FROM (
                SELECT p.user_id AS user_id, m.created_at AS created_at, m.id AS match_id,
                       p.result AS result,
                       ROW_NUMBER() OVER (PARTITION BY p.user_id
                                          ORDER BY m.created_at DESC, m.id DESC) AS rn
                  FROM match_participants p
                  JOIN matches m ON m.id = p.match_id
                 WHERE m.rated = 1
                   AND COALESCE(m.rating_mode, 'default') = ?
                   AND p.user_id IN (${marks})
            )
            WHERE rn <= ${STREAK_LOOKBACK}
            ORDER BY user_id, created_at ASC, match_id ASC`;
}

/** Pure: rows grouped by player (oldest first within each) → current streak per player. */
export function currentStreaksFrom(
    rows: ReadonlyArray<{ user_id: string; created_at: string; result: number }>,
    nowMs: number,
): Map<string, number> {
    const byUser = new Map<string, { atMs: number; result: number }[]>();
    for (const r of rows) {
        const list = byUser.get(r.user_id) ?? [];
        list.push({ atMs: sqliteTimestampToMs(r.created_at) ?? 0, result: r.result });
        byUser.set(r.user_id, list);
    }
    const out = new Map<string, number>();
    for (const [user, list] of byUser) out.set(user, streakSummary(list, nowMs).current);
    return out;
}

/** The current streak of each listed player on one ladder. Best-effort: empty on failure. */
export async function currentStreaks(
    ctx: AppContext,
    userIds: readonly string[],
    mode: RatingMode,
    nowMs: number,
): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    try {
        const res = await ctx.db.prepare(recentResultsSql(userIds.length))
            .bind(mode, ...userIds)
            .all<{ user_id: string; created_at: string; result: number }>();
        return currentStreaksFrom(res.results ?? [], nowMs);
    } catch {
        return new Map();
    }
}
