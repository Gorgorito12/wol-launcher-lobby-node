/**
 * Ban refunds: what the summing rule gives back, and the SQL that picks the losses. Run: `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { refundTotals } from './refunds';
import { REFUND_LOSSES_SQL } from './ladder';

test('THE ONE THAT MATTERS: one total per player and ladder, losses only', () => {
    const totals = refundTotals([
        { user_id: 'ana', mode: 'default', rating_before: 1600, rating_after: 1588 },
        { user_id: 'ana', mode: 'default', rating_before: 1588, rating_after: 1570 },
        { user_id: 'ana', mode: 'team', rating_before: 1500, rating_after: 1490 },
        { user_id: 'luis', mode: 'default', rating_before: 1400, rating_after: 1420 }, // he WON: nothing
    ]);
    assert.deepEqual(totals, [
        { userId: 'ana', mode: 'default', points: 30, matches: 2 },
        { userId: 'ana', mode: 'team', points: 10, matches: 1 },
    ]);
});

test('a refund never names the banned player: the totals carry recipients only', () => {
    const totals = refundTotals([{ user_id: 'ana', mode: 'default', rating_before: 1600, rating_after: 1580 }]);
    for (const t of totals) assert.deepEqual(Object.keys(t).sort(), ['matches', 'mode', 'points', 'userId']);
});

test('the losses query: rated, up to the refund, only the other side, only points lost', () => {
    assert.match(REFUND_LOSSES_SQL, /m\.rated = 1/);
    assert.match(REFUND_LOSSES_SQL, /m\.created_at <= \?/, 'nothing after the refund itself');
    assert.match(REFUND_LOSSES_SQL, /p\.team <> b\.team/, 'teammates lost nothing to him');
    assert.match(REFUND_LOSSES_SQL, /p\.rating_after < p\.rating_before/);
    assert.match(REFUND_LOSSES_SQL, /m\.created_at > \?/, 'never twice: after the previous refund');
});
