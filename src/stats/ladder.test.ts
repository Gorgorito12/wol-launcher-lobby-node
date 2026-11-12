/**
 * Who is ranked, who is still being placed, and in what order. Run: `npm test`.
 *
 * The SQL itself is checked against a real database by scripts/test-admin.ts; what is pinned here
 * is the decision the SQL encodes, through the constants the queries are built from, so a later
 * edit cannot quietly put an old behaviour back while the tests stay green.
 *
 * The ladder used to be ordered by `rating − 2·rd` because a newcomer with three lucky wins
 * otherwise topped the table. Placement removes the cause instead: nobody is ranked before ten
 * rated 1v1 matches (five in teams), so the table is sorted by the number it prints.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MIN_DECIDED, LADDER_ORDER_BY, LADDER_WHERE, compareLadder, ladderBinds, ladderRankSql,
} from './rest';
import {
    INACTIVE_AFTER_MS, isInactive, isInPlacement, isRanked, orderPlacement, PLACEMENT_REQUIRED,
    placementRequired,
} from '../elo/placement';

test('THE ONE THAT MATTERS: the table is ordered by the rating it prints', () => {
    assert.match(LADDER_ORDER_BY, /^e\.rating DESC/);
    // No discount by the deviation any more: placement keeps the newcomer off the table.
    assert.doesNotMatch(LADDER_ORDER_BY, /rd/);
    // A deterministic tiebreak, or the room's position and the table's could name different
    // players for the same place.
    assert.match(LADDER_ORDER_BY, /,\s*e\.user_id ASC\s*$/);
});

test('placement: 10 rated matches in 1v1, 5 in teams', () => {
    assert.equal(PLACEMENT_REQUIRED.default, 10);
    assert.equal(PLACEMENT_REQUIRED.team, 5);
    assert.equal(placementRequired('default'), 10);
    assert.equal(placementRequired('team'), 5);
    // The payload's min_decided has always been "how many to enter": now it is exactly that.
    assert.equal(MIN_DECIDED, 10);
});

test('placement boundaries: 9 of 10 is placement, 10 of 10 is ranked', () => {
    assert.equal(isInPlacement(9, 'default'), true);
    assert.equal(isRanked(9, 'default'), false);
    assert.equal(isInPlacement(10, 'default'), false);
    assert.equal(isRanked(10, 'default'), true);
    assert.equal(isInPlacement(4, 'team'), true);
    assert.equal(isRanked(5, 'team'), true);
});

test('nobody with no rated match is listed anywhere', () => {
    assert.equal(isInPlacement(0, 'default'), false);
    assert.equal(isRanked(0, 'default'), false);
    assert.equal(isInPlacement(1, 'default'), true, 'the very first match starts placement');
});

test('the ladder and its size ask the same question, bound mode then requirement', () => {
    assert.match(LADDER_WHERE.trim(), /^WHERE/);
    assert.match(LADDER_WHERE, /e\.mode\s*=\s*\?/);
    assert.match(LADDER_WHERE, /u\.is_banned\s*=\s*0/);
    assert.match(LADDER_WHERE, /e\.games_played\s*>=\s*\?/);
    assert.equal((LADDER_WHERE.match(/\?/g) ?? []).length, 2);
    assert.deepEqual(ladderBinds('default'), ['default', 10]);
    assert.deepEqual(ladderBinds('team'), ['team', 5]);
    // Inactive players are NOT filtered out: they keep their place.
    assert.doesNotMatch(LADDER_WHERE, /last_rated_at/);
});

test("the room's position and the table's are the same query", () => {
    const sql = ladderRankSql(3);
    assert.ok(sql.includes(LADDER_WHERE), 'the position must filter exactly like the list');
    assert.ok(sql.includes(`ORDER BY ${LADDER_ORDER_BY}`), 'and order exactly like it');
    assert.match(sql, /FROM player_ratings e/);
    assert.match(sql, /ROW_NUMBER\(\)/);
    assert.match(sql, /IN \(\?, \?, \?\)/);
});

test('ties are broken by user id, the same way in JS and in SQL', () => {
    const a = { rating: 1600, user_id: 'b' };
    const b = { rating: 1600, user_id: 'a' };
    const c = { rating: 1700, user_id: 'z' };
    assert.deepEqual([a, b, c].sort(compareLadder).map((r) => r.user_id), ['z', 'a', 'b']);
});

test('inactive: thirty days without a rated match, to the second', () => {
    const now = Date.UTC(2026, 9, 3, 12);
    assert.equal(isInactive(now - INACTIVE_AFTER_MS, now), false, 'exactly 30 days is still active');
    assert.equal(isInactive(now - INACTIVE_AFTER_MS - 1000, now), true);
    assert.equal(isInactive(now - INACTIVE_AFTER_MS + 1000, now), false);
    assert.equal(isInactive(null, now), false, 'unknown is not inactive');
});

test('placement rows: most matches first, then by name, then by id', () => {
    const rows = [
        { user_id: 'u3', display_name: 'luis', placement_played: 3 },
        { user_id: 'u1', display_name: 'Ana', placement_played: 6 },
        { user_id: 'u2', display_name: 'beto', placement_played: 3 },
        { user_id: 'u4', display_name: 'Beto', placement_played: 3 },
    ];
    assert.deepEqual(orderPlacement(rows).map((r) => r.user_id), ['u1', 'u2', 'u4', 'u3']);
});
