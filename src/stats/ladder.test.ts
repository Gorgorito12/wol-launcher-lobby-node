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
import { MIN_DECIDED, LADDER_ORDER_BY, LADDER_WHERE, conservativeRating } from './rest';

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
    assert.match(LADDER_ORDER_BY, /e\.rd/);
    assert.match(LADDER_ORDER_BY, /DESC\s*$/);
});

test('the entry bar is a floor, not the mechanism', () => {
    // Low ON PURPOSE. A bar high enough to exclude the three-match player on its own emptied the
    // table: this community plays ~35 rated matches a month, and at 5 the live table held two
    // names. It exists to keep a single lucky night off the board; the ordering does the rest.
    assert.ok(MIN_DECIDED >= 2, 'one rated match should not be enough to appear');
    assert.ok(MIN_DECIDED <= 5, 'a higher bar empties the table for this community');

    // On the live numbers it removes exactly the 0-1 player, and nobody who has actually played.
    const eligible = LIVE.filter(r => r.games >= MIN_DECIDED).map(r => r.name);
    assert.ok(!eligible.includes('Gorgorito12'));
    assert.ok(eligible.includes('Aluclown'));
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
