import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentStreaksFrom, recentResultsSql, STREAK_LOOKBACK } from './currentStreaks';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-10-03T12:00:00Z');
const at = (daysAgo: number) =>
    new Date(now - daysAgo * DAY).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

test('the current streak is the run of wins ending at the latest match', () => {
    const map = currentStreaksFrom([
        { user_id: 'a', created_at: at(5), result: 0 },
        { user_id: 'a', created_at: at(4), result: 1 },
        { user_id: 'a', created_at: at(3), result: 1 },
        { user_id: 'a', created_at: at(2), result: 1 },
        { user_id: 'b', created_at: at(2), result: 1 },
        { user_id: 'b', created_at: at(1), result: 0 },
    ], now);
    assert.equal(map.get('a'), 3);
    assert.equal(map.get('b'), 0);
});

test('fourteen days without a rated match end the streak, as on the profile', () => {
    const map = currentStreaksFrom([
        { user_id: 'a', created_at: at(20), result: 1 },
        { user_id: 'a', created_at: at(16), result: 1 },
        { user_id: 'a', created_at: at(15), result: 1 },
    ], now);
    assert.equal(map.get('a'), 0);
});

test('a player with no rated match in the mode is simply absent', () => {
    assert.equal(currentStreaksFrom([], now).size, 0);
});

test('the query reads one page in one statement and keeps the look-back bound', () => {
    const sql = recentResultsSql(3);
    assert.match(sql, /IN \(\?, \?, \?\)/);
    assert.match(sql, new RegExp(`rn <= ${STREAK_LOOKBACK}`));
    assert.match(sql, /m\.rated = 1/);
    assert.match(sql, /COALESCE\(m\.rating_mode, 'default'\) = \?/);
});
