/**
 * Placement and inactivity: who is ranked, who is still being placed, who has gone quiet.
 *
 * <p><b>Placement.</b> A player's first {@link PLACEMENT_REQUIRED} rated matches on a ladder — ten
 * in 1v1, five in teams, against anyone, counting the ones already played before this rule
 * existed — place him. Until then he is NOT ranked: he has no position and no badge, and the
 * ladder lists him at the end of the same table with his progress. The rating still moves from
 * his very first match; placement is about where he is SHOWN, not about how he is rated.</p>
 *
 * <p><b>Inactivity.</b> Thirty days without a rated match on a ladder marks a player inactive on
 * it. He KEEPS his place: the flag is a label, not a sanction, and it goes with his next rated
 * match. His uncertainty has been growing meanwhile (src/elo/glicko2.ts, decayRd), which is what
 * makes his first matches back move him more.</p>
 *
 * <p>Pure; the callers do the I/O.</p>
 */
import type { RatingMode } from './glicko2';

export const PLACEMENT_REQUIRED: Readonly<Record<RatingMode, number>> = Object.freeze({
    default: 10,
    team: 5,
});

export const INACTIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export function placementRequired(mode: RatingMode): number {
    return PLACEMENT_REQUIRED[mode];
}

/** Ranked: placement finished. */
export function isRanked(gamesPlayed: number, mode: RatingMode): boolean {
    return gamesPlayed >= placementRequired(mode);
}

/** Being placed: at least one rated match and fewer than required. Nobody with none is listed. */
export function isInPlacement(gamesPlayed: number, mode: RatingMode): boolean {
    return gamesPlayed > 0 && gamesPlayed < placementRequired(mode);
}

/** Inactive: more than thirty days since the last rated match on this ladder. Unknown is not inactive. */
export function isInactive(lastRatedAtMs: number | null, nowMs: number): boolean {
    if (lastRatedAtMs === null || !Number.isFinite(lastRatedAtMs)) return false;
    return nowMs - lastRatedAtMs > INACTIVE_AFTER_MS;
}

export interface PlacementOrderRow {
    user_id: string;
    display_name: string;
    placement_played: number;
}

/**
 * How the placement rows are listed under the table: most matches played first (the closest to
 * entering), then by name, then by id so two equal rows never swap between requests.
 */
export function orderPlacement<T extends PlacementOrderRow>(rows: readonly T[]): T[] {
    return [...rows].sort((a, b) =>
        b.placement_played - a.placement_played
        || a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base' })
        || (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));
}
