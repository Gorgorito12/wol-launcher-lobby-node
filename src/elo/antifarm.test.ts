/**
 * Anti-farm. Run: `npm test`.
 *
 * The edges are the point: the first two wins are free, the 3rd is 90 %, the 10th and every one
 * after are 20 %, a loss resets, each full 24 h recovers one step, and tournaments are invisible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { antifarmStep, factorForStreak, matchupKey, sideKey, type FarmLink } from './antifarm';

const H = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1, 12);

/** Play a sequence of results between A and B, one hour apart unless a gap is given. */
function chain(events: Array<{ winner: string | null; gapMs?: number; tournament?: boolean }>) {
    let prev: FarmLink | null = null;
    let at = T0;
    const out: Array<{ factor: number; streak: number | null }> = [];
    for (const e of events) {
        at += e.gapMs ?? H;
        const step = antifarmStep(prev, { atMs: at, winnerKey: e.winner, isTournament: !!e.tournament });
        out.push(step);
        if (!e.tournament) prev = { atMs: at, streak: step.streak ?? 0, winnerKey: e.winner };
    }
    return out;
}

test('THE ONE THAT MATTERS: 12 straight wins — 100, 100, 90 … 20, 20, 20', () => {
    const f = chain(Array.from({ length: 12 }, () => ({ winner: 'A' }))).map((s) => s.factor);
    assert.deepEqual(f, [1, 1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.2, 0.2]);
});

test('the factor table, exactly', () => {
    assert.equal(factorForStreak(1), 1);
    assert.equal(factorForStreak(2), 1);
    assert.equal(factorForStreak(3), 0.9);
    assert.equal(factorForStreak(8), 0.4);
    assert.equal(factorForStreak(9), 0.3);
    assert.equal(factorForStreak(10), 0.2);
    assert.equal(factorForStreak(25), 0.2);
});

test('one win by the other side resets it to 100 %', () => {
    const f = chain([
        { winner: 'A' }, { winner: 'A' }, { winner: 'A' }, { winner: 'A' },
        { winner: 'B' },
        { winner: 'A' }, { winner: 'A' }, { winner: 'A' },
    ]).map((s) => s.factor);
    assert.deepEqual(f, [1, 1, 0.9, 0.8, 1, 1, 1, 0.9]);
});

test('each full 24 h without playing recovers 10 %', () => {
    // Four wins (80 %), then a day off: the fifth would have been 70 %, it is 80 %.
    const f = chain([
        { winner: 'A' }, { winner: 'A' }, { winner: 'A' }, { winner: 'A' },
        { winner: 'A', gapMs: 24 * H },
    ]).map((s) => s.factor);
    assert.deepEqual(f, [1, 1, 0.9, 0.8, 0.8]);
});

test('23 hours is not a day: no recovery', () => {
    const f = chain([
        { winner: 'A' }, { winner: 'A' }, { winner: 'A' },
        { winner: 'A', gapMs: 23 * H },
    ]).map((s) => s.factor);
    assert.deepEqual(f, [1, 1, 0.9, 0.8]);
});

test('from the minimum, one day off is one step back up: 20 % → 30 %', () => {
    const events = Array.from({ length: 10 }, () => ({ winner: 'A' as string | null }));
    events.push({ winner: 'A', gapMs: 24 * H } as { winner: string | null; gapMs: number });
    const f = chain(events).map((s) => s.factor);
    assert.equal(f[9], 0.2);
    assert.equal(f[10], 0.3);
});

test('a long break resets it entirely', () => {
    const f = chain([
        { winner: 'A' }, { winner: 'A' }, { winner: 'A' }, { winner: 'A' }, { winner: 'A' },
        { winner: 'A', gapMs: 30 * 24 * H },
    ]).map((s) => s.factor);
    assert.equal(f[5], 1);
});

test('tournament games are invisible: they neither count nor break the chain', () => {
    const steps = chain([
        { winner: 'A' }, { winner: 'A' },
        { winner: 'A', tournament: true },
        { winner: 'B', tournament: true },
        { winner: 'A' },
    ]);
    assert.deepEqual(steps.map((s) => s.factor), [1, 1, 1, 1, 0.9]);
    assert.equal(steps[2]!.streak, null, 'never stored as part of the chain');
});

test('a draw resets the chain', () => {
    const f = chain([{ winner: 'A' }, { winner: 'A' }, { winner: 'A' }, { winner: null }, { winner: 'A' }])
        .map((s) => s.factor);
    assert.deepEqual(f, [1, 1, 0.9, 1, 1]);
});

test('the matchup is the exact pair of sides, whoever won and in whatever order', () => {
    assert.equal(sideKey(['b', 'a', 'c']), 'a,b,c');
    assert.equal(matchupKey('team', [['b', 'a'], ['d', 'c']]), matchupKey('team', [['c', 'd'], ['a', 'b']]));
    // One different player is a different matchup.
    assert.notEqual(matchupKey('team', [['a', 'b'], ['c', 'd']]), matchupKey('team', [['a', 'b'], ['c', 'e']]));
    // Same people, different split, different matchup.
    assert.notEqual(matchupKey('team', [['a', 'b'], ['c', 'd']]), matchupKey('team', [['a', 'c'], ['b', 'd']]));
    // The ladder is part of it.
    assert.notEqual(matchupKey('default', [['a'], ['b']]), matchupKey('team', [['a'], ['b']]));
});
