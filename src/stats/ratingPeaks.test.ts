/**
 * The ladder's PEAK column: each player's peak, for a whole page at once. Run: `npm test`.
 *
 * The SQL itself is checked against a real database by scripts/test-rating-peaks.ts; what is pinned
 * here is that a page is cut by player before the profile's rule runs, and that the queries read the
 * same matches and refunds the profile's do.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ratedRowsSql, ratingPeaksFrom, refundsSql } from './ratingPeaks';
import { peakAndLow, type RatedRow, type RefundPoint } from './standing';

const day = (n: number) => `2026-09-${String(n).padStart(2, '0')} 12:00:00`;

/** One player's rated matches, a day apart, starting on `firstDay`. */
const rows = (user: string, afters: number[], firstDay = 1) => afters.map((a, i) => ({
    user_id: user, match_id: `${user}${i}`, created_at: day(firstDay + i),
    result: 1, rating_before: null, rating_after: a,
}));

const own = (list: ReadonlyArray<RatedRow & { user_id: string }>, user: string) => list.filter((r) => r.user_id === user);
const ownRefunds = (list: ReadonlyArray<RefundPoint & { user_id: string }>, user: string) => list.filter((r) => r.user_id === user);

test('THE ONE THAT MATTERS: each player gets exactly the peak his profile shows', () => {
    // Two players' rows interleaved by date, as one query over a page returns them before sorting —
    // plus a refund for each. Whatever the order, nothing of one may reach the other.
    const a = rows('a', [1500, 1520, 1610, 1580, 1650, 1600]);
    const b = rows('b', [1700, 1720, 1690, 1800, 1760, 1740], 2);
    const all = [...a, ...b].sort((x, y) => x.created_at.localeCompare(y.created_at));
    const refunds = [
        { user_id: 'a', created_at: day(20), rating_after: 1660 },
        { user_id: 'b', created_at: day(21), rating_after: 1750 },
    ];

    const peaks = ratingPeaksFrom(
        [...own(all, 'a'), ...own(all, 'b')], refunds, 3);

    for (const user of ['a', 'b']) {
        const profile = peakAndLow(own(all, user), ownRefunds(refunds, user), 3);
        assert.deepEqual(peaks.get(user), { peak: profile.peak, peakAt: profile.peakAt });
    }
    assert.equal(peaks.get('a')?.peak, 1660);    // his refund, after placement, is his peak
    assert.equal(peaks.get('b')?.peak, 1800);    // b's lower refund changes nothing for him
});

test('a player still being placed comes back with no peak', () => {
    const peaks = ratingPeaksFrom(rows('p', [1500, 2100]), [], 10);
    assert.deepEqual(peaks.get('p'), { peak: null, peakAt: null });
});

test('a refund belongs to its own player only', () => {
    const peaks = ratingPeaksFrom(
        [...rows('a', [1500, 1510, 1520]), ...rows('b', [1600, 1610, 1620])],
        [{ user_id: 'b', created_at: day(10), rating_after: 2000 }],
        3);
    assert.equal(peaks.get('a')?.peak, 1520);
    assert.equal(peaks.get('b')?.peak, 2000);
});

test('a player with no rated match in the mode is simply absent, and an empty page is empty', () => {
    assert.equal(ratingPeaksFrom(rows('a', [1500, 1510, 1520]), [], 3).has('z'), false);
    assert.equal(ratingPeaksFrom([], [], 10).size, 0);
});

test('the queries read one page in one statement each, with the profile\'s filters', () => {
    const matches = ratedRowsSql(3);
    assert.match(matches, /IN \(\?, \?, \?\)/);
    assert.match(matches, /m\.rated = 1/);
    assert.match(matches, /COALESCE\(m\.rating_mode, 'default'\) = \?/);
    // Oldest first within a player: the N-th row is the one that finished placement.
    assert.match(matches, /ORDER BY p\.user_id, m\.created_at ASC, m\.id ASC/);

    const refunds = refundsSql(2);
    assert.match(refunds, /IN \(\?, \?\)/);
    assert.match(refunds, /r\.mode = \?/);
    assert.match(refunds, /b\.revoked_at IS NULL/);
    assert.match(refunds, /ORDER BY b\.created_at ASC/);
});
