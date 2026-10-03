/**
 * Ban refunds: when a player is banned for cheating, his opponents get back the points they lost
 * to him — summed into ONE notice per player and ladder, and never naming him.
 *
 * <p><b>Only losses, only to him.</b> A match against the banned player that his opponent WON is
 * left alone (that win was real for the winner), and in a team game only the players on the side
 * OPPOSITE him are refunded: his teammates lost nothing to him.</p>
 *
 * <p><b>Deterministic.</b> A refund is an event on the rating timeline (`ban_refunds.created_at`)
 * and its amount is re-derived by every replay from the stamps of the matches it covers, so voiding
 * one of those matches later shrinks the refund on its own, and an unban that revokes the refund
 * simply removes the event. The I/O lives in src/elo/ladder.ts (applyRefund).</p>
 */

export interface RefundLossRow {
    user_id: string;
    mode: string;
    rating_before: number;
    rating_after: number;
}

export interface RefundTotal {
    userId: string;
    mode: string;
    points: number;
    matches: number;
}

/** Sum the points each (player, ladder) lost. Rows that did not lose points contribute nothing. */
export function refundTotals(rows: readonly RefundLossRow[]): RefundTotal[] {
    const byKey = new Map<string, RefundTotal>();
    for (const r of rows) {
        const lost = r.rating_before - r.rating_after;
        if (!(lost > 0)) continue;
        const key = `${r.user_id}\u0000${r.mode}`;
        const t = byKey.get(key) ?? { userId: r.user_id, mode: r.mode, points: 0, matches: 0 };
        t.points += lost;
        t.matches += 1;
        byKey.set(key, t);
    }
    return [...byKey.values()].sort((a, b) =>
        a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : a.mode < b.mode ? -1 : a.mode > b.mode ? 1 : 0);
}
