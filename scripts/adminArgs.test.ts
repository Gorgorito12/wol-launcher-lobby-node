import test from 'node:test';
import assert from 'node:assert/strict';
import { bareArgsOf, looksLikeDbPath } from './adminArgs';

const dbPathOf = (argv: string[]) => bareArgsOf(argv).find(looksLikeDbPath) ?? null;

test('a file given to --file is never taken for the database', () => {
    const argv = ['replay:attach', 'abc-123', '--file', '/tmp/wadmalaw.age3Yrec', '--apply'];
    assert.deepEqual(bareArgsOf(argv), ['replay:attach', 'abc-123']);
    assert.equal(dbPathOf(argv), null);
});

test('the = form works the same', () => {
    const argv = ['replay:attach', 'abc-123', '--file=/tmp/x.age3Yrec'];
    assert.deepEqual(bareArgsOf(argv), ['replay:attach', 'abc-123']);
    assert.equal(dbPathOf(argv), null);
});

test('a reason with a slash is a reason, not a database', () => {
    const argv = ['player:ban', 'alice', '--reason', 'smurf/alt account'];
    assert.deepEqual(bareArgsOf(argv), ['player:ban', 'alice']);
    assert.equal(dbPathOf(argv), null);
});

test('a real database path is still found', () => {
    const argv = ['match:show', 'abc-123', '/var/lib/wol-lobby/lobby.db'];
    assert.equal(dbPathOf(argv), '/var/lib/wol-lobby/lobby.db');
});

test('a flag before the command does not become the command', () => {
    assert.equal(bareArgsOf(['--winner', 'bob', 'match:decide', 'abc-123'])[0], 'match:decide');
});

test('a boolean flag consumes nothing', () => {
    assert.deepEqual(bareArgsOf(['rooms:list', '--stale', 'extra']), ['rooms:list', 'extra']);
    assert.deepEqual(bareArgsOf(['replay:attach', '--force', 'abc-123']), ['replay:attach', 'abc-123']);
});

test('a value flag at the end, or followed by another flag, consumes nothing', () => {
    assert.deepEqual(bareArgsOf(['replay:attach', 'abc', '--file']), ['replay:attach', 'abc']);
    assert.deepEqual(bareArgsOf(['replay:attach', 'abc', '--file', '--apply']), ['replay:attach', 'abc']);
});
