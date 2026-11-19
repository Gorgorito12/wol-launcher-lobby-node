import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gameRulesLabel, resolveGameRules } from './gameRules';

const casual = { competitive: false, bound: false };

test('a casual room keeps the rules it asked for', () => {
    for (let n = 0; n <= 7; n++) assert.equal(resolveGameRules(n, casual), n);
});

test('THE ONE THAT MATTERS: a ranked room is always Standard', () => {
    assert.equal(resolveGameRules(5, { competitive: true, bound: false }), 0);
});

test('a tournament or quick-match room is always Standard', () => {
    assert.equal(resolveGameRules(7, { competitive: false, bound: true }), 0);
});

test('anything that is not an integer 0-7 is Standard', () => {
    for (const bad of [8, -1, 2.5, '3', null, undefined, NaN, Infinity, {}, true]) {
        assert.equal(resolveGameRules(bad, casual), 0, String(bad));
    }
});

test('every value has a name, and an unknown one reads Standard', () => {
    assert.equal(gameRulesLabel(5), 'Treaty · 40 min');
    assert.equal(gameRulesLabel(7), 'King of the Hill');
    assert.equal(gameRulesLabel(99), 'Standard');
});
