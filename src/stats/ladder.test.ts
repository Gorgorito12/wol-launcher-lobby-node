/**
 * Who gets on the ladder, and in what order. Run: `npm test`.
 *
 * The SQL itself is still checked against a real database on deploy (see DEPLOY.md) — there is
 * no database harness in this repo and this change did not warrant inventing one. What IS pinned
 * here is the decision the SQL encodes, through the constants the query is built from, so a
 * later edit cannot quietly put the old behaviour back while the tests stay green.
 *
 * The rule now: PLACEMENT, then the plain rating. A player plays MIN_DECIDED rated matches before
 * he is ranked, and the table is ordered by the rating it prints. It used to be ordered by
 * `rating - 2*rd`, which kept a newcomer with a hot start down but left the printed column out of
 * order — 1571 above 1720 on the live table, reported as "a higher ELO is placed lower".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MIN_DECIDED, LADDER_ORDER_BY, LADDER_WHERE, compareLadder, ladderRankSql,
} from './rest';

/** The live table the day the conservative order went in (games = rated matches). */
const LIVE = [
    { name: 'Gommiustan', rating: 1626.34, rd: 248.23, games: 3, user_id: 'g' },
    { name: 'Aluclown', rating: 1603.58, rd: 125.29, games: 13, user_id: 'a' },
    { name: 'Geaf_Argento', rating: 1509.62, rd: 132.88, games: 9, user_id: 'f' },
    { name: 'Gorgorito12', rating: 1383.36, rd: 286.93, games: 1, user_id: 'z' },
];

const table = (rows: typeof LIVE) =>
    rows.filter(r => r.games >= MIN_DECIDED).sort(compareLadder).map(r => r.name);

test('the ladder is ordered by the rating it prints', () => {
    // THE regression: the printed column must descend. Reverting to `(e.rating - 2 * e.rd)` would
    // fail here instead of silently restoring a table where 1571 sits above 1720.
    assert.match(LADDER_ORDER_BY, /^e\.rating DESC/);
    assert.doesNotMatch(LADDER_ORDER_BY, /rd/);
    // And it has a deterministic tiebreak, or the room's position and the table's could name
    // different players for the same place.
    assert.match(LADDER_ORDER_BY, /,\s*e\.user_id ASC\s*$/);

    const shown = [
        { rating: 1571, user_id: 'x' }, { rating: 1720, user_id: 'y' }, { rating: 1643, user_id: 'w' },
    ].sort(compareLadder).map(r => r.rating);
    assert.deepEqual(shown, [1720, 1643, 1571]);
});

test('placement, not the ordering, keeps the newcomer with a hot start off the top', () => {
    // On the day's numbers: Gommiustan (3 matches, the highest rating) and Gorgorito12 (1) are
    // in placement, so the table is the two regulars, by rating.
    assert.deepEqual(table(LIVE), ['Aluclown', 'Geaf_Argento']);
    const inPlacement = LIVE.filter(r => r.games >= 1 && r.games < MIN_DECIDED).map(r => r.name);
    assert.deepEqual(inPlacement.sort(), ['Gommiustan', 'Gorgorito12']);
});

test('placement is five rated matches', () => {
    // AoE3: DE uses ten; at ~4 rated matches per player per month ten would keep an ordinary
    // player off the table for a quarter. See MIN_DECIDED before moving it.
    assert.equal(MIN_DECIDED, 5);
    // Never fewer than one: `elo_ratings` gains a row when applyMatch first runs, so a player
    // with nothing decided has no rating to rank.
    assert.ok(MIN_DECIDED >= 1);
});

test('the ladder and its size ask the same question', () => {
    // The profile says "rank 7 of 18". The 7 comes from the list, the 18 from a COUNT, and
    // if those two ever filter differently the sentence is wrong in a way neither side can
    // see — a player at "7 of 18" in a table showing 20 names. There is one WHERE and both
    // queries interpolate it; this pins that it still says what it has to say.
    assert.match(LADDER_WHERE, /e\.mode\s*=\s*\?/);
    assert.match(LADDER_WHERE, /u\.is_banned\s*=\s*0/);
    assert.match(LADDER_WHERE, /e\.games_played\s*>=\s*\?/);

    // And that it is a WHERE rather than something that would silently splice into the
    // COUNT query, which has no JOINs of its own to hang a condition on.
    assert.match(LADDER_WHERE.trim(), /^WHERE/);
});

test("the room's position and the table's are the same query", () => {
    // The rooms row and the room panel show a badge worked out from a position the TABLE never
    // sent them. If that position came from a second WHERE or a second ORDER BY, a player could
    // be 3rd in the table and wear the 4th-place badge in a room.
    const sql = ladderRankSql(3);
    assert.ok(sql.includes(LADDER_WHERE), 'the position must filter exactly like the list');
    assert.ok(sql.includes(`ORDER BY ${LADDER_ORDER_BY}`), 'and order exactly like it');
    assert.match(sql, /ROW_NUMBER\(\)/);
    assert.match(sql, /IN \(\?, \?, \?\)/);
});

test('ties are broken by user id, the same way in JS and in SQL', () => {
    const a = { rating: 1600, user_id: 'b' };
    const b = { rating: 1600, user_id: 'a' };
    const order = [a, b].sort(compareLadder).map(r => r.user_id);
    assert.deepEqual(order, ['a', 'b']);
    // And a better rating still beats the id.
    const d = { rating: 1601, user_id: 'zz' };
    assert.equal([a, b, d].sort(compareLadder)[0].user_id, 'zz');
});
