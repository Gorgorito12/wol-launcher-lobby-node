/**
 * The lock that keeps a ladder replay from crossing a match being rated. Run: `npm test`.
 *
 * <b>What it protects.</b> `recomputeLadder` resets every rating to 1500 and rebuilds them one
 * match at a time. A report that lands inside that window reads a half-built ladder, computes a
 * delta from 1500 and writes it — and the replay, working from a list fetched before that match
 * existed, then overwrites it. The match keeps its `rating_before`/`rating_after` stamps and
 * moved nothing, and nobody ever sees it happen. So what is pinned here is the one property
 * that prevents it: two rating writes launched at the same time never overlap.
 *
 * The replay itself needs a database and is exercised by `scripts/test-admin.ts`, whose first
 * test is that replaying untouched data moves nobody.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withLadderLock } from './replay';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('THE ONE THAT MATTERS: two rating writes launched together never overlap', async () => {
    const events: string[] = [];

    const job = (name: string) => withLadderLock(async () => {
        events.push(`${name}:start`);
        await tick();
        events.push(`${name}:end`);
        return name;
    });

    // Launched together, deliberately not awaited in turn — this is the shape of a report
    // arriving while a replay runs.
    const [a, b, c] = await Promise.all([job('replay'), job('report'), job('confirm')]);

    assert.deepEqual([a, b, c], ['replay', 'report', 'confirm']);
    // Every start is immediately followed by its own end: no interleaving anywhere.
    assert.deepEqual(events, [
        'replay:start', 'replay:end',
        'report:start', 'report:end',
        'confirm:start', 'confirm:end',
    ]);
});

test('the order is the order they asked', async () => {
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4].map((n) => withLadderLock(async () => { order.push(n); })));
    assert.deepEqual(order, [1, 2, 3, 4]);
});

test('a failure releases the lock — one bad write must not wedge every later one', async () => {
    // The reason this is a chain with a .catch rather than a boolean flag: a flag left true by
    // a throw stops every rating on the server, silently, until a restart.
    await assert.rejects(withLadderLock(async () => { throw new Error('applyMatch blew up'); }));

    const after = await withLadderLock(async () => 'still works');
    assert.equal(after, 'still works');
});

test('the value comes back to its own caller', async () => {
    const results = await Promise.all([
        withLadderLock(async () => 'a'),
        withLadderLock(async () => 'b'),
    ]);
    assert.deepEqual(results, ['a', 'b']);
});
