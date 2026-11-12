/**
 * Who is ranked, who is still being placed, and in what order. Run: `npm test`.
 *

 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {

    assert.match(LADDER_ORDER_BY, /,\s*e\.user_id ASC\s*$/);


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

