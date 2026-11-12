/** Streaks. Run: `npm test`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bestWinRunWithin, STREAK_IDLE_CUTOFF_MS, streakSummary } from './streaks';

const D = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 1, 12);
const at = (day: number) => T0 + day * D;
const W = 1;
const L = 0;

test('wins in a row, and a loss cuts them', () => {
    const rows = [W, W, W, L, W, W].map((r, i) => ({ atMs: at(i), result: r }));
    const s = streakSummary(rows, at(6));
    assert.equal(s.current, 2);
    assert.equal(s.best, 3);
    assert.equal(s.lossBest, 1);
    assert.equal(s.endedAt, null);
});

test('THE ONE THAT MATTERS: fourteen days without a rated match end the current streak', () => {
    const rows = [W, W, W, W].map((r, i) => ({ atMs: at(i), result: r }));
    const last = at(3);
    assert.equal(streakSummary(rows, last + STREAK_IDLE_CUTOFF_MS).current, 4, 'exactly 14 days: still alive');
    const after = streakSummary(rows, last + STREAK_IDLE_CUTOFF_MS + 1000);
    assert.equal(after.current, 0);
    assert.equal(after.best, 4, 'the best is kept');
    assert.equal(after.endedAt, last + STREAK_IDLE_CUTOFF_MS, 'it ended 14 days after the last match');
});

test('a gap of more than fourteen days between matches breaks a run', () => {
    const rows = [
        { atMs: at(0), result: W }, { atMs: at(1), result: W },
        { atMs: at(20), result: W },
    ];
    const s = streakSummary(rows, at(21));
    assert.equal(s.current, 1);
    assert.equal(s.best, 2);
});

test('the longest losing streak, and a win breaks it', () => {
    const rows = [L, L, L, W, L, L].map((r, i) => ({ atMs: at(i), result: r }));
    const s = streakSummary(rows, at(6));
    assert.equal(s.lossBest, 3);
    assert.equal(s.current, 0);
    assert.equal(s.endedAt, null, 'cut by a loss, not by the clock');
});

test('a draw breaks both kinds of run', () => {
    const rows = [W, W, 0.5, W].map((r, i) => ({ atMs: at(i), result: r }));
    assert.equal(streakSummary(rows, at(4)).current, 1);
});

test('nothing played: all zero', () => {
    assert.deepEqual(streakSummary([], at(0)), { current: 0, best: 0, lossBest: 0, endedAt: null });
});

test('the best run of a month counts only the month\'s matches', () => {
    const rows = [W, W, W, W, W].map((r, i) => ({ atMs: at(i), result: r }));
    // A window that starts on day 2: the run counts from there.
    assert.equal(bestWinRunWithin(rows, at(2), at(10)), 3);
    assert.equal(bestWinRunWithin(rows, at(10), at(20)), 0);
});
