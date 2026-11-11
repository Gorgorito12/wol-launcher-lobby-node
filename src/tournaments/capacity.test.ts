/**
 * How big a tournament may be. Run: `npm test`.
 *
 * The bug this guards was silent: the launcher asked for 32, the server cut it to 16 and answered
 * 200, and the organiser found out from the bracket.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clampCapacity, DEFAULT_CAPACITY, MAX_CAPACITY, MIN_CAPACITY } from './capacity';
import { bracketSize, generateBracket, roundsFor } from './bracket';

test('32 and 64 survive the clamp', () => {
    assert.equal(clampCapacity(32), 32);
    assert.equal(clampCapacity(64), 64);
    assert.equal(MAX_CAPACITY, 64);
});

test('what is out of range or not a number stays inside', () => {
    assert.equal(clampCapacity(65), MAX_CAPACITY);
    assert.equal(clampCapacity(1), MIN_CAPACITY);
    assert.equal(clampCapacity('32'), DEFAULT_CAPACITY);
    assert.equal(clampCapacity(Number.NaN), DEFAULT_CAPACITY);
    assert.equal(clampCapacity(undefined), DEFAULT_CAPACITY);
});

for (const entrants of [17, 32, 33, 64]) {
    test(`a bracket of ${entrants} has its rounds and one final`, () => {
        const size = bracketSize(entrants);
        assert.equal(size, entrants <= 32 ? 32 : 64);
        assert.equal(roundsFor(entrants), Math.log2(size));
        let next = 0;
        const matches = generateBracket(
            Array.from({ length: entrants }, (_, i) => ({ entrantId: `e${i + 1}`, seed: i + 1 })),
            () => `m${++next}`,
        );
        assert.equal(matches.length, size - 1, 'a knockout of N slots has N - 1 matches');
        assert.equal(matches.filter((m) => m.nextMatchId === null).length, 1, 'one final');
    });
}

test('a list row and the detail both say the limit', () => {
    const rest = readFileSync('src/tournaments/rest.ts', 'utf8');
    assert.match(rest, /payload = \{ tournaments: rows\.map\(listView\), max_capacity: MAX_CAPACITY \}/);
    assert.equal((rest.match(/max_capacity: MAX_CAPACITY,/g) ?? []).length, 2);
});
