/** Quick-match pairing rules. Run: `npm test`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    chooseHost, compatible, decayedStrikes, kindsMeet, lockForStrike, pickPair, playKindFor, windowOf,
    STRIKE_DECAY_MS, type MmTicket,
} from './pairing.js';

function t(over: Partial<MmTicket> & { userId: string }): MmTicket {
    return {
        id: `t-${over.userId}`, modId: 'wol', modHash: 'H', kind: 'ranked', rating: 1500, placing: false,
        queuedAt: 0, radminReady: false, hostOk: true, ...over,
    };
}

test('the window widens by 100 every 30 s and has no limit from two minutes', () => {
    assert.equal(windowOf({ placing: false, queuedAt: 0 }, 0), 150);
    assert.equal(windowOf({ placing: false, queuedAt: 0 }, 29_999), 150);
    assert.equal(windowOf({ placing: false, queuedAt: 0 }, 30_000), 250);
    assert.equal(windowOf({ placing: false, queuedAt: 0 }, 119_000), 450);
    assert.equal(windowOf({ placing: false, queuedAt: 0 }, 120_000), Number.POSITIVE_INFINITY);
});

test('a placing player has no window of his own', () => {
    assert.equal(windowOf({ placing: true, queuedAt: 0 }, 0), Number.POSITIVE_INFINITY);
});

test('either meets both, ranked and casual never meet', () => {
    assert.equal(kindsMeet('either', 'either'), 'ranked');
    assert.equal(kindsMeet('either', 'casual'), 'casual');
    assert.equal(kindsMeet('ranked', 'either'), 'ranked');
    assert.equal(kindsMeet('ranked', 'casual'), null);
    assert.equal(playKindFor('either', false), 'casual');
    assert.equal(playKindFor('either', true), 'ranked');
});

test('another version of the mod, another mod, or the same person never pair', () => {
    assert.equal(compatible(t({ userId: 'a' }), t({ userId: 'b', modHash: 'X' })), null);
    assert.equal(compatible(t({ userId: 'a' }), t({ userId: 'b', modId: 'im' })), null);
    assert.equal(compatible(t({ userId: 'a' }), t({ userId: 'a', id: 'other' })), null);
    assert.equal(compatible(t({ userId: 'a', modHash: 'h' }), t({ userId: 'b', modHash: 'H' })), 'ranked');
});

test('THE ONE THAT MATTERS: a gap both windows accept pairs, the closest first', () => {
    const a = t({ userId: 'a', rating: 1500 });
    const b = t({ userId: 'b', rating: 1700 });
    const c = t({ userId: 'c', rating: 1560 });
    assert.deepEqual(pickPair([a, b, c], 0)?.a.userId, 'a');
    const p = pickPair([a, b, c], 0)!;
    assert.deepEqual([p.a.userId, p.b.userId].sort(), ['a', 'c']);
    // Alone with b, a gap of 200 waits until both windows reach it.
    assert.equal(pickPair([a, b], 0), null);
    assert.ok(pickPair([a, b], 30_000));
});

test("both windows must accept the gap, not only the longer waiter's", () => {
    const old = t({ userId: 'old', rating: 1500, queuedAt: 0 });
    const fresh = t({ userId: 'new', rating: 1800, queuedAt: 200_000 });
    assert.equal(pickPair([old, fresh], 200_000), null, 'the newcomer has a 150 window');
    assert.ok(pickPair([old, fresh], 320_000));
});

test("a placing player is matched within the other's window only", () => {
    const p = t({ userId: 'p', placing: true, rating: 1500 });
    const far = t({ userId: 'f', rating: 2000 });
    assert.equal(pickPair([p, far], 0), null);
    assert.ok(pickPair([p, t({ userId: 'n', rating: 1600 })], 0));
});

test('the host is the one Radmin can reach, then the willing one, then the older', () => {
    const base = { radminReady: false, hostOk: true, queuedAt: 10 };
    assert.equal(chooseHost({ ...base, userId: 'a' }, { ...base, userId: 'b', radminReady: true }), 'b');
    assert.equal(chooseHost({ ...base, userId: 'a', hostOk: false }, { ...base, userId: 'b' }), 'b');
    assert.equal(chooseHost({ ...base, userId: 'a', queuedAt: 5 }, { ...base, userId: 'b' }), 'a');
});

test('strikes: a warning, then 2, 10 and 30 minutes; one forgiven every six hours', () => {
    assert.equal(lockForStrike(1), 0);
    assert.equal(lockForStrike(2), 120_000);
    assert.equal(lockForStrike(3), 600_000);
    assert.equal(lockForStrike(9), 1_800_000);
    assert.equal(decayedStrikes(3, 0, STRIKE_DECAY_MS * 2), 1);
    assert.equal(decayedStrikes(1, 0, STRIKE_DECAY_MS * 5), 0);
});
