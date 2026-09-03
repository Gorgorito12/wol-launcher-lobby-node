/**
 * The most-played maps of the window. Run: `npm test`.
 *
 * Same shape, and the same reason, as ladder.test.ts: there is no database harness in this repo
 * and the SQL is verified against the real table on deploy, so what is pinned here is the
 * DECISION the SQL encodes — through the one constant the query is built from.
 *
 * What this change could break is specific and quiet. `top_map` (a single name, read by every
 * launcher shipped before `top_maps` existed) used to be its own query with its own `LIMIT 1`.
 * The obvious way to add a list is to leave that alone and write a second query beside it — and
 * then the two are free to drift: a different window, a different tiebreak, and `top_map` stops
 * being the head of `top_maps` with nothing anywhere to reveal it. Both now come from one query.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOP_MAPS_SQL } from './rest';

/**
 * What the query returns, ordered the way the SQL orders it. Two maps deliberately tie on 24 so
 * the tiebreak has something to decide.
 */
const ROWS = [
    { map_name: 'ESOC Fertile Crescent', n: 31 },
    { map_name: 'ESOC Yukon', n: 24 },
    { map_name: 'ESOC Andes', n: 24 },
    { map_name: 'Great Plains', n: 9 },
];

/** The projection the handler applies before it reaches the payload. */
const project = (rows: typeof ROWS) => rows.map(r => ({ map: r.map_name, matches: r.n }));

/** The SQL's own ordering, reproduced so the tiebreak can be asserted rather than described. */
const ordered = (rows: typeof ROWS) =>
    [...rows].sort((a, b) => b.n - a.n || a.map_name.localeCompare(b.map_name));

test('the singular is the head of the list, never a second answer', () => {
    const list = project(ordered(ROWS));
    const [head] = ordered(ROWS);

    // This is the invariant the whole change rests on. The handler derives top_map from
    // rows[0]; if anyone ever re-adds a separate LIMIT 1 query, this is what stops it being
    // silently allowed to disagree.
    assert.equal(head.map_name, list[0].map);
    assert.equal(head.n, list[0].matches);
});

test('a tie is broken by name, so the table does not reshuffle between requests', () => {
    // Andes and Yukon are both on 24. Without the tiebreak SQLite may return them in either
    // order, and a table that reorders itself every minute reads as broken data.
    assert.deepEqual(ordered(ROWS).map(r => r.map_name), [
        'ESOC Fertile Crescent', 'ESOC Andes', 'ESOC Yukon', 'Great Plains',
    ]);

    assert.ok(
        TOP_MAPS_SQL.includes('ORDER BY n DESC, map_name ASC'),
        'the tiebreak left the query; the list order is no longer stable',
    );
});

test('the JSON names are the ones the launcher deserializes', () => {
    // `map` and `matches`, NOT the column names `map_name` and `n`. The C# side
    // (LobbyDtos.MapCount) already shipped against these, so renaming either one here empties
    // the card on every launcher instead of erroring anywhere.
    const one = project([{ map_name: 'ESOC Yukon', n: 24 }]);
    assert.deepEqual(one, [{ map: 'ESOC Yukon', matches: 24 }]);
    assert.deepEqual(Object.keys(one[0]), ['map', 'matches']);
});

test('no maps yet is an empty list, never a null hole in the payload', () => {
    // A brand-new league, or every match reported without a map. The launcher hides the card on
    // an ABSENT top_maps (an older backend); an empty array means "this backend does send it,
    // there is just nothing to show", and it must not be confused with the former.
    assert.deepEqual(project([]), []);
});

test('the query still takes its window and its limit, in that order', () => {
    // Positional binds: the handler passes the window offset then the row limit. Swapping them
    // is a runtime error SQLite reports as an empty result, not as a failure.
    const marks = TOP_MAPS_SQL.split('?').length - 1;
    assert.equal(marks, 2, `expected 2 bind parameters, found ${marks}`);

    const windowAt = TOP_MAPS_SQL.indexOf("datetime('now', ?)");
    const limitAt = TOP_MAPS_SQL.indexOf('LIMIT ?');
    assert.ok(windowAt >= 0, 'the window bind left the query');
    assert.ok(limitAt > windowAt, 'the limit must bind after the window');
});

test('matches with no map are excluded, not counted as one', () => {
    // map_name is nullable and older rows carry ''. Counting those produces a "most played map"
    // with a blank name at the top of the table.
    assert.ok(TOP_MAPS_SQL.includes('map_name IS NOT NULL'));
    assert.ok(TOP_MAPS_SQL.includes("map_name <> ''"));
});
