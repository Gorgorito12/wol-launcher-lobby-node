/**
 * The PEAK of every player on a ladder page — the launcher's PEAK column beside the rating
 * (2026-10-28). One pair of queries for the whole page, never one per row — the same rule
 * `currentStreaks` and `topCivsSql` follow.
 *
 * <p><b>The rule is the profile's, not a copy of it.</b> Each player's rows go through
 * {@link peakAndLow}, the function `standingFor` uses for the peak on his profile, over the SAME
 * rated matches and the SAME unrevoked refunds, read with the same filters. So the table and the
 * profile cannot disagree about a player's peak: the ratings he held AFTER finishing placement,
 * refunds from then on included, and null while he is still being placed.</p>
 *
 * <p><b>No placement privacy question arises</b> (src/elo/placementPrivacy.ts): the ladder lists
 * only players who have finished placement, and the peak never counts a rating from before that.</p>
 */
import type { RatingMode } from '../elo/glicko2';
import { placementRequired } from '../elo/placement';
import type { AppContext } from '../context';
import { peakAndLow, type RatedRow, type RefundPoint } from './standing';

/** A peak and the moment it was first reached, as the profile sends them. */
export interface RatingPeak {
    peak: number | null;
    peakAt: string | null;
}

const marks = (players: number): string => Array.from({ length: players }, () => '?').join(', ');

/**
 * Every rated match of each listed player in one mode, oldest first within a player — the query
 * `standingFor` runs for one player, for the whole page. Binds: the mode, then one id per player.
 */
export function ratedRowsSql(players: number): string {
    return `SELECT p.user_id AS user_id, m.id AS match_id, m.created_at AS created_at,
                   p.result AS result, p.rating_before AS rating_before, p.rating_after AS rating_after
              FROM matches m
              JOIN match_participants p ON p.match_id = m.id
             WHERE m.rated = 1
               AND COALESCE(m.rating_mode, 'default') = ?
               AND p.user_id IN (${marks(players)})
             ORDER BY p.user_id, m.created_at ASC, m.id ASC`;
}

/**
 * The unrevoked refunds of each listed player in one mode, oldest first — `standingFor`'s refund
 * query for the whole page. Binds: the mode, then one id per player.
 */
export function refundsSql(players: number): string {
    return `SELECT r.user_id AS user_id, b.created_at AS created_at, r.rating_after AS rating_after
              FROM rating_refunds r
              JOIN ban_refunds b ON b.id = r.refund_id
             WHERE r.mode = ?
               AND b.revoked_at IS NULL
               AND r.user_id IN (${marks(players)})
             ORDER BY b.created_at ASC`;
}

/**
 * Pure: the rows of a whole page, grouped by player, through {@link peakAndLow}. A player with no
 * rated match in the mode is simply absent; one still being placed comes back with nulls.
 */
export function ratingPeaksFrom(
    rows: ReadonlyArray<RatedRow & { user_id: string }>,
    refunds: ReadonlyArray<RefundPoint & { user_id: string }>,
    required: number,
): Map<string, RatingPeak> {
    const rowsBy = new Map<string, RatedRow[]>();
    for (const r of rows) {
        const list = rowsBy.get(r.user_id) ?? [];
        list.push(r);
        rowsBy.set(r.user_id, list);
    }
    const refundsBy = new Map<string, RefundPoint[]>();
    for (const f of refunds) {
        const list = refundsBy.get(f.user_id) ?? [];
        list.push(f);
        refundsBy.set(f.user_id, list);
    }

    const out = new Map<string, RatingPeak>();
    for (const [user, list] of rowsBy) {
        const extremes = peakAndLow(list, refundsBy.get(user) ?? [], required);
        out.set(user, { peak: extremes.peak, peakAt: extremes.peakAt });
    }
    return out;
}

/**
 * The peak of each listed player on one ladder. Best-effort: an empty map on failure, which leaves
 * every row of the page without a peak — and a launcher draws no PEAK column for such a page.
 */
export async function ratingPeaks(
    ctx: AppContext,
    userIds: readonly string[],
    mode: RatingMode,
): Promise<Map<string, RatingPeak>> {
    if (userIds.length === 0) return new Map();
    try {
        const rows = await ctx.db.prepare(ratedRowsSql(userIds.length))
            .bind(mode, ...userIds)
            .all<RatedRow & { user_id: string }>();
        const refunds = await ctx.db.prepare(refundsSql(userIds.length))
            .bind(mode, ...userIds)
            .all<RefundPoint & { user_id: string }>();
        return ratingPeaksFrom(rows.results ?? [], refunds.results ?? [], placementRequired(mode));
    } catch {
        return new Map();
    }
}
