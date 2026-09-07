/**
 * What each ladder row says a player plays, and how many recent matches a caller can ask
 * for. Run: `npm test`.
 *
 * Same split as `ladder.test.ts`: no database harness, so the SQL is pinned as a string and
 * the cut — top three, most played first, name as the tiebreak — as a pure function.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    topCivsFor, topCivsSql, TOP_CIVS_PER_PLAYER,
    recentParam, RECENT_MATCHES_LIMIT, RECENT_MATCHES_MAX, communityKey,
} from './rest';

// ---------------------------------------------------------------- top_civs

test('THE ONE THAT MATTERS: most played first, three at most, and a name breaks the tie', () => {
    const rows = [
        { user_id: 'a', civ: 'Zulu', played: 2 },
        { user_id: 'a', civ: 'Ethiopians', played: 7 },
        { user_id: 'a', civ: 'Dutch', played: 2 },
        { user_id: 'a', civ: 'Aztecs', played: 1 },
        { user_id: 'b', civ: 'Ottomans', played: 1 },
    ];
    const top = topCivsFor(rows);

    // Ethiopians by count; then Dutch before Zulu on the same count, by name, so the same
    // record is listed the same way on every request rather than in SQLite's grouping order.
    assert.deepEqual(top.get('a'), [
        { civ: 'Ethiopians', played: 7 },
        { civ: 'Dutch', played: 2 },
        { civ: 'Zulu', played: 2 },
    ]);
    assert.equal(top.get('a')?.length, TOP_CIVS_PER_PLAYER);
    assert.deepEqual(top.get('b'), [{ civ: 'Ottomans', played: 1 }]);
});

test('a player with nothing known is simply absent, and the row falls back to an empty list', () => {
    // The ladder does `topCivs.get(id) ?? []`: an empty list, never null and never a made-up
    // "unknown" entry. The launcher hides the flags for that row and nothing else.
    const top = topCivsFor([]);
    assert.equal(top.get('nobody'), undefined);
    assert.deepEqual(top.get('nobody') ?? [], []);
});

test('the query counts RATED matches of the ladder\'s mode, skips blanks, and takes one placeholder per player', () => {
    const sql = topCivsSql(3);
    assert.match(sql, /m\.rated = 1/);
    assert.match(sql, /COALESCE\(m\.rating_mode, 'default'\) = \?/);
    assert.match(sql, /mp\.civ IS NOT NULL AND TRIM\(mp\.civ\) <> ''/);
    assert.match(sql, /mp\.user_id IN \(\?, \?, \?\)/);
    assert.match(sql, /GROUP BY mp\.user_id, mp\.civ/);
    // No window, on purpose: with today's data a thirty-day window answers "nothing" for
    // almost everybody. A later edit that adds one should have to delete this line.
    assert.equal(sql.includes("datetime('now'"), false);
    // Placeholders: the mode, then one per player — the order ladder() binds them in.
    assert.equal(sql.match(/\?/g)?.length, 4);
});

// ---------------------------------------------------------------- recent=N

test('recent defaults to what it always was, and is clamped', () => {
    assert.equal(recentParam(undefined), RECENT_MATCHES_LIMIT);
    assert.equal(recentParam(''), RECENT_MATCHES_LIMIT);
    assert.equal(recentParam('lots'), RECENT_MATCHES_LIMIT);
    assert.equal(recentParam('30'), 30);
    assert.equal(recentParam('0'), 1);
    assert.equal(recentParam('-4'), 1);
    assert.equal(recentParam('9999'), RECENT_MATCHES_MAX);
    assert.ok(RECENT_MATCHES_MAX >= 30, 'the ranking page asks for thirty');
});

test('the memo key tells five recent matches from thirty', () => {
    // Without this the Rooms strip and the Ranking history would serve each other's payload
    // for a minute at a time, and both would look correct.
    assert.notEqual(communityKey(10, 'wol', 'default', 5), communityKey(10, 'wol', 'default', 30));
    // And a caller that never says is the default, so old keys keep hitting.
    assert.equal(communityKey(10, 'wol', 'default'), communityKey(10, 'wol', 'default', RECENT_MATCHES_LIMIT));
});
