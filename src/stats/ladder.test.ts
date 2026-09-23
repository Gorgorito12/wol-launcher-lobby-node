/**
 * Who gets on the ladder, and in what order. Run: `npm test`.
 *
 * The SQL itself is still checked against a real database on deploy (see DEPLOY.md) — there is
 * no database harness in this repo and this change did not warrant inventing one. What IS pinned
 * here is the decision the SQL encodes, through the two constants the query is built from, so a
 * later edit cannot quietly put the old behaviour back while the tests stay green.
 *
 * The bug it exists for, from the live table the day it was written:
 *
 *   Gommiustan  1626  rd 248   3 matches
 *   Aluclown    1604  rd 125  13 matches
 *
 * Ordered by rating, the player with three matches was first and the one with thirteen second.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MIN_DECIDED, LADDER_ORDER_BY, LADDER_WHERE, conservativeRating, compareLadder, ladderRankSql,
} from './rest';

/** The live table, the day the rule changed. */
const LIVE = [
    { name: 'Gommiustan', rating: 1626.34, rd: 248.23, games: 3 },
    { name: 'Aluclown', rating: 1603.58, rd: 125.29, games: 13 },
    { name: 'Geaf_Argento', rating: 1509.62, rd: 132.88, games: 9 },
    { name: 'Gorgorito12', rating: 1383.36, rd: 286.93, games: 1 },
];

const byConservative = (rows: typeof LIVE) =>
    [...rows].sort((a, b) => conservativeRating(b) - conservativeRating(a)).map(r => r.name);

test('the newcomer with a hot start does not outrank the regular', () => {
    // This is the whole point, on the real numbers: thirteen matches above three.
    assert.deepEqual(byConservative(LIVE), [
        'Aluclown', 'Geaf_Argento', 'Gommiustan', 'Gorgorito12',
    ]);

    // ...and by raw rating it is the other way round, which is what was being complained about.
    const byRating = [...LIVE].sort((a, b) => b.rating - a.rating).map(r => r.name);
    assert.equal(byRating[0], 'Gommiustan');
});

test('a big deviation is a discount, not a bonus', () => {
    // Same rating, different certainty: the one we know more about ranks higher. Getting this
    // backwards (rating + 2*rd) would still "work" on a table where the best player is also the
    // most established, and would be invisible until someone new won a few.
    const sure = { rating: 1600, rd: 60 };
    const unsure = { rating: 1600, rd: 300 };
    assert.ok(conservativeRating(sure) > conservativeRating(unsure));
});

test('the coefficient is 2, and one is not enough', () => {
    // Measured: with a single deviation Gommiustan comes SECOND, not third — the discount is
    // too shallow to place three matches behind nine. Documented so the number is not tuned
    // down as a tidy-up.
    const byOneRd = [...LIVE]
        .sort((a, b) => (b.rating - b.rd) - (a.rating - a.rd))
        .map(r => r.name);
    assert.equal(byOneRd[1], 'Gommiustan');
    assert.equal(byConservative(LIVE)[2], 'Gommiustan');
});

test('the ORDER BY still discounts the deviation', () => {
    // The query is built from this constant, so reverting it to a plain `e.rating DESC` — the
    // tempting "optimisation", since the index is on (mode, rating DESC) — fails here instead
    // of silently restoring the bug.
    assert.match(LADDER_ORDER_BY, /^\(e\.rating - 2 \* e\.rd\) DESC/);
    // And it has a deterministic tiebreak, or the room's position and the table's could name
    // different players for the same place.
    assert.match(LADDER_ORDER_BY, /,\s*e\.user_id ASC\s*$/);
});

test('five rated matches to be on the ladder, and never fewer than one', () => {
    // It went 5 -> 1 -> 5. The reason it is back is the rank badge: a place on the table is now
    // a medal, and a medal is a claim that somebody has shown their level. See MIN_DECIDED.
    assert.equal(MIN_DECIDED, 5);

    // Still refused, and not a judgement: `elo_ratings` gains a row when applyMatch first runs,
    // so somebody with nothing decided has no rating to rank.
    assert.ok(MIN_DECIDED >= 1, 'a player with no rated match has no rating to rank');

    // On the day's numbers: the three- and one-match players wait; the rest are on the table.
    const eligible = LIVE.filter(r => r.games >= MIN_DECIDED).map(r => r.name);
    assert.deepEqual(eligible.sort(), ['Aluclown', 'Geaf_Argento']);
});

test('the ordering, not a bar, is what keeps the one-match player down', () => {
    // THE REPLACEMENT for the assertion above. With the floor gone this is the only thing
    // standing between a newcomer and the top of the table, so it is pinned on its own rather
    // than left implied by the ordering tests: Gorgorito12 has ONE rated match and the highest
    // deviation on the board, and he comes last.
    assert.equal(byConservative(LIVE).at(-1), 'Gorgorito12');

    // And by raw rating he is third of four - so the discount is doing the work, not the rating.
    const byRating = [...LIVE].sort((a, b) => b.rating - a.rating).map(r => r.name);
    assert.equal(byRating.indexOf('Gorgorito12'), 3);
    assert.ok(conservativeRating(LIVE[3]) < conservativeRating(LIVE[2]));
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
    const a = { rating: 1600, rd: 100, user_id: 'b' };
    const b = { rating: 1600, rd: 100, user_id: 'a' };
    const c = { rating: 1700, rd: 150, user_id: 'z' }; // same conservative rating, 1400
    const order = [a, b, c].sort(compareLadder).map(r => r.user_id);
    assert.deepEqual(order, ['a', 'b', 'z']);
    // And a better conservative rating still beats the id.
    const d = { rating: 1601, rd: 100, user_id: 'zz' };
    assert.equal([a, b, d].sort(compareLadder)[0].user_id, 'zz');
});
