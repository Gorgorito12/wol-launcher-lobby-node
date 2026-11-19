import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageBounds, ageFor, nextAgeTarget } from './ages';

/**
 * THE SAME TABLE IS IN THE LAUNCHER (BadgeProgressViewTests.TheAgeCutsMatchTheServers). It is
 * literal on purpose: computing it here from the function would test nothing. If the shares ever
 * change, both tables change in the same edit, or the badge and "N points to Imperial" disagree.
 */
const TABLE: Record<number, [number, number, number, number]> = {
    1: [1, 2, 3, 4], 2: [1, 2, 3, 4], 3: [1, 2, 3, 4], 4: [1, 2, 3, 4], 5: [1, 2, 3, 4],
    6: [1, 2, 3, 5], 7: [1, 2, 4, 5], 8: [1, 2, 4, 6], 9: [1, 3, 5, 7], 10: [1, 3, 5, 7],
    11: [2, 3, 5, 8], 12: [2, 3, 6, 9], 13: [2, 4, 6, 10], 14: [2, 4, 7, 10], 15: [2, 4, 7, 11],
    16: [2, 4, 8, 12], 17: [2, 5, 8, 12], 18: [2, 5, 9, 13], 19: [2, 5, 9, 14], 20: [2, 5, 9, 14],
    25: [3, 7, 12, 18], 30: [3, 8, 14, 21], 40: [4, 10, 18, 28], 50: [5, 13, 23, 35], 60: [6, 15, 27, 42],
};

test('the age cuts are the launcher\'s, size by size', () => {
    for (const [size, expected] of Object.entries(TABLE)) {
        assert.deepEqual(ageBounds(Number(size)), expected, `size ${size}`);
    }
});

test('the next age is the last place of the age above', () => {
    // 18 players: 1-2 / 3-5 / 6-9 / 10-13 / 14-18.
    assert.deepEqual(nextAgeTarget(14, 18), { age: 'fortress', atRank: 13, places: 1 });
    assert.deepEqual(nextAgeTarget(7, 18), { age: 'imperial', atRank: 5, places: 2 });
    assert.equal(ageFor(3, 18), 'imperial');
});

test('nothing above the top, nothing off the table', () => {
    assert.equal(nextAgeTarget(1, 18), null);
    assert.equal(nextAgeTarget(2, 18), null);
    assert.equal(nextAgeTarget(0, 18), null);
    assert.equal(nextAgeTarget(19, 18), null);
});
