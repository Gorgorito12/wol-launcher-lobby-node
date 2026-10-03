/** Operator alerts: the counting rules. Run: `npm test`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rawConsecutiveWins, shortMatchCount } from './alerts';

test('wins in a row by the same side, raw, from the newest backwards', () => {
    assert.equal(rawConsecutiveWins(['A', 'A', 'A', 'B', 'A']), 3);
    assert.equal(rawConsecutiveWins(['B', 'A']), 1);
    assert.equal(rawConsecutiveWins([]), 0);
    assert.equal(rawConsecutiveWins([null, 'A']), 0, 'a draw ends it');
});

test('short matches: strictly under the threshold', () => {
    assert.equal(shortMatchCount([100, 599, 600, 1200], 600), 2);
    assert.equal(shortMatchCount([], 600), 0);
});
