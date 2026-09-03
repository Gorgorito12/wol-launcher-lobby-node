/**
 * Which statistics belong to which mod. Run: `npm test`.
 *
 * Same split as `ladder.test.ts`: there is no database harness here, so what is pinned is the
 * SQL the decision is written in.
 *
 * The bug this closes was silent and already shipped. `/stats/civs`, `/stats/matchups` and
 * `/stats/decks` have always GROUPED by `mod_id` — the rows carried it and the launcher drew
 * all of them. With two mods installed, or two builds of one mod, the same civilization
 * appeared twice with different numbers and nothing on the screen said why. The maps and the
 * totals had the opposite problem: no mod dimension at all, on a page whose other half was
 * per-mod.
 *
 * The rule these tests exist to hold: **the mod filter is applied to every window query of a
 * page, or to none of them.** Half a page filtered is worse than none of it, because the two
 * halves then disagree and both look correct.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    TOP_MAPS_SQL, topMapsSql, MATCHUPS_SQL, matchupsSql, DECK_CARDS_SQL, deckCardsSql,
} from './rest';

// ---------------------------------------------------------------- the maps query

test('without a mod the map query is exactly what it always was', () => {
    // A launcher that has never heard of the parameter keeps getting what it got. That is the
    // whole compatibility story for this change, so it is asserted rather than assumed.
    assert.equal(topMapsSql(null), TOP_MAPS_SQL);
    assert.equal(TOP_MAPS_SQL.includes('mod_id'), false);
});

test('with a mod the map query gains exactly one predicate', () => {
    const sql = topMapsSql('wol');
    assert.match(sql, /AND mod_id = \?/);
    assert.equal(sql.match(/mod_id/g)?.length, 1);
});

test('THE ONE THAT MATTERS: the mod predicate does not disturb the window or the order', () => {
    // The window and the tiebreak are the two things this query gets right, and both are easy
    // to lose to a careless string edit. The tiebreak is not decoration: without it two maps
    // on the same count swap places between one request and the next, which reorders the whole
    // table for no reason.
    const sql = topMapsSql('wol');
    assert.match(sql, /created_at >= datetime\('now', \?\)/);
    assert.match(sql, /ORDER BY n DESC, map_name ASC/);
    assert.match(sql, /GROUP BY map_name/);
    // And the placeholders stay in the order the caller binds them: window, mod, limit.
    const order = [sql.indexOf("datetime('now', ?)"), sql.indexOf('mod_id = ?'), sql.lastIndexOf('?')];
    assert.deepEqual([...order].sort((a, b) => a - b), order);
});

// ---------------------------------------------------------------- matchups

test('the matchup query keeps its self-join guards when scoped to a mod', () => {
    // `a.civ < b.civ` does two jobs: it drops the mirror of every pair, and it stops a match
    // becoming a matchup of a civilization against itself. The mod predicate is spliced in
    // beside it, so this is exactly where a bad edit would land.
    const sql = matchupsSql('wol');
    assert.match(sql, /a\.civ < b\.civ/);
    assert.match(sql, /b\.user_id <> a\.user_id/);
    assert.match(sql, /AND m\.mod_id = \?/);
});

test('unscoped, the matchup query is untouched', () => {
    assert.equal(matchupsSql(null), MATCHUPS_SQL);
});

test('the matchup query still groups by mod even when it filters by one', () => {
    // Filtering narrows to one mod; the GROUP BY also splits by BUILD. Dropping the group
    // because the filter looks like it makes it redundant would average two versions of a
    // mod together, which is the thing the grouping exists to prevent.
    assert.match(matchupsSql('wol'), /GROUP BY m\.mod_id, m\.mod_combined_hash/);
});

// ---------------------------------------------------------------- decks

test('the deck query gains a WHERE and keeps its grouping', () => {
    const sql = deckCardsSql('wol');
    assert.match(sql, /FROM deck_cards WHERE mod_id = \?/);
    assert.match(sql, /GROUP BY mod_id, civ, card/);
    assert.match(sql, /ORDER BY players DESC, civ ASC, card ASC/);
});

test('unscoped, the deck query is untouched', () => {
    assert.equal(deckCardsSql(null), DECK_CARDS_SQL);
    assert.equal(DECK_CARDS_SQL.includes('WHERE'), false);
});

test('THE ONE THAT MATTERS: decks count PLAYERS and never rows', () => {
    // A player carries many cards, so counting rows would report a multiple of the real
    // headcount. This is the one number on that table somebody might quote.
    assert.match(deckCardsSql('wol'), /COUNT\(DISTINCT user_id\) AS players/);
});
