import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devTokenRefusal, devUserRow } from './devToken';

test('a token is minted only in dev mode', () => {
    assert.equal(devTokenRefusal({ devAuthBypass: true }, 'a'), null);
    assert.notEqual(devTokenRefusal({ devAuthBypass: false }, 'a'), null);
});

test('only a short slug is a test id', () => {
    for (const bad of ['', 'A', 'a b', 'a/b', "a'", 'x'.repeat(33), '../x']) {
        assert.notEqual(devTokenRefusal({ devAuthBypass: true }, bad), null, bad);
    }
});

test('each account has its own discord id, so two never overwrite each other', () => {
    const a = devUserRow('a', 'TestA');
    const b = devUserRow('b', 'TestB');
    assert.notEqual(a.discordId, b.discordId);
    assert.notEqual(a.id, b.id);
    assert.ok(a.discordId.startsWith('dev:'));
});
