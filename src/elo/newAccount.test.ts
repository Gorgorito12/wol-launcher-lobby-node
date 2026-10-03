/**
 * The new-account rule. Run: `npm test`.
 *
 * All three conditions at once, or nothing: the rejections are the point, because each signal on
 * its own describes a lot of honest players.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isNewAccountShort, NEW_ACCOUNT_AGE_MS } from './newAccount';

const D = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 3, 12);
const SHORT = 600;

function p(userId: string, side: number, ageDays: number | null, ips: string[]) {
    return {
        userId, side,
        accountCreatedMs: ageDays === null ? null : NOW - ageDays * D,
        ipHashes: new Set(ips),
    };
}

test('THE ONE THAT MATTERS: new account + short match + same network as the opponent', () => {
    assert.equal(isNewAccountShort({
        participants: [p('a', 0, 2, ['h1']), p('b', 1, 400, ['h1'])],
        durationSeconds: 240, matchAtMs: NOW, shortSeconds: SHORT,
    }), true);
});

test('an old account on both sides is not caught', () => {
    assert.equal(isNewAccountShort({
        participants: [p('a', 0, 30, ['h1']), p('b', 1, 400, ['h1'])],
        durationSeconds: 240, matchAtMs: NOW, shortSeconds: SHORT,
    }), false);
});

test('a real-length match is not caught', () => {
    assert.equal(isNewAccountShort({
        participants: [p('a', 0, 2, ['h1']), p('b', 1, 400, ['h1'])],
        durationSeconds: SHORT, matchAtMs: NOW, shortSeconds: SHORT,
    }), false);
});

test('different networks are not caught', () => {
    assert.equal(isNewAccountShort({
        participants: [p('a', 0, 2, ['h1']), p('b', 1, 400, ['h2'])],
        durationSeconds: 120, matchAtMs: NOW, shortSeconds: SHORT,
    }), false);
});

test('teammates on one LAN are never caught', () => {
    assert.equal(isNewAccountShort({
        participants: [p('a', 1, 2, ['h1']), p('b', 1, 400, ['h1']), p('c', 2, 400, ['h9']), p('d', 2, 400, ['h8'])],
        durationSeconds: 120, matchAtMs: NOW, shortSeconds: SHORT,
    }), false);
});

test('missing IP data or account age answers no', () => {
    assert.equal(isNewAccountShort({
        participants: [p('a', 0, 2, []), p('b', 1, 400, [])],
        durationSeconds: 120, matchAtMs: NOW, shortSeconds: SHORT,
    }), false);
    assert.equal(isNewAccountShort({
        participants: [p('a', 0, null, ['h1']), p('b', 1, null, ['h1'])],
        durationSeconds: 120, matchAtMs: NOW, shortSeconds: SHORT,
    }), false);
});

test('the account age is measured at the MATCH, so a replay agrees', () => {
    const created = NOW - NEW_ACCOUNT_AGE_MS + D; // six days old at NOW
    const parts = [
        { userId: 'a', side: 0, accountCreatedMs: created, ipHashes: new Set(['h1']) },
        { userId: 'b', side: 1, accountCreatedMs: NOW - 400 * D, ipHashes: new Set(['h1']) },
    ];
    assert.equal(isNewAccountShort({ participants: parts, durationSeconds: 60, matchAtMs: NOW, shortSeconds: SHORT }), true);
    assert.equal(isNewAccountShort({ participants: parts, durationSeconds: 60, matchAtMs: NOW + 2 * D, shortSeconds: SHORT }), false);
});
