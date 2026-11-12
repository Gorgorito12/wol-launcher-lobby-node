/** A player's standing: peak and low. Run: `npm test`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { peakAndLow } from './standing';

const rows = (afters: number[]) => afters.map((a, i) => ({
    match_id: `m${i}`, created_at: `2026-09-${String(i + 1).padStart(2, '0')} 12:00:00`,
    result: 1, rating_before: null, rating_after: a,
}));

test('THE ONE THAT MATTERS: no peak or low until placement is done', () => {
    assert.deepEqual(peakAndLow(rows([1700, 1800, 1650]), [], 5),
        { peak: null, peakAt: null, low: null, lowAt: null });
});

test('peak and low count from the match that finished placement on', () => {
    // Placement of 3: the 2100 at match 2 is a placement swing and does not count.
    const r = peakAndLow(rows([1600, 2100, 1700, 1750, 1680]), [], 3);
    assert.equal(r.peak, 1750);
    assert.equal(r.low, 1680);
    assert.equal(r.peakAt, '2026-09-04T12:00:00Z');
});

test('a refund after placement can set the peak', () => {
    const r = peakAndLow(rows([1600, 1610, 1620]), [{ created_at: '2026-09-10 12:00:00', rating_after: 1700 }], 3);
    assert.equal(r.peak, 1700);
    assert.equal(r.peakAt, '2026-09-10T12:00:00Z');
});

test('the first time a value was reached is its date', () => {
    const r = peakAndLow(rows([1600, 1700, 1650, 1700]), [], 2);
    assert.equal(r.peakAt, '2026-09-02T12:00:00Z');
});
