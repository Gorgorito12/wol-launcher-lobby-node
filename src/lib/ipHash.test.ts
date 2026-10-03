/** IP hashing. Run: `npm test`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalIp, hashIp, ipHashSecret, requestIp } from './ipHash';

test('THE ONE THAT MATTERS: X-Real-IP, never the first X-Forwarded-For entry', () => {
    // nginx APPENDS to X-Forwarded-For, so its first entry is whatever the client sent.
    assert.equal(requestIp({ headers: { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4, 203.0.113.7' } }), '203.0.113.7');
    assert.equal(requestIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
    assert.equal(requestIp({ headers: {} }), null);
});

test('canonical form: IPv4-mapped becomes IPv4, IPv6 is cut to its /64', () => {
    assert.equal(canonicalIp('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(canonicalIp('2001:db8:aaaa:bbbb:1:2:3:4'), canonicalIp('2001:0db8:aaaa:bbbb:ffff::9'));
    assert.notEqual(canonicalIp('2001:db8:aaaa:bbbb::1'), canonicalIp('2001:db8:aaaa:cccc::1'));
});

test('the hash is stable, secret-dependent, and never the address', () => {
    const h = hashIp('203.0.113.7', 's1');
    assert.equal(h, hashIp('203.0.113.7', 's1'));
    assert.notEqual(h, hashIp('203.0.113.7', 's2'));
    assert.equal(h.length, 32);
    assert.ok(!h.includes('203'));
});

test('a secret always exists', () => {
    assert.equal(ipHashSecret({ ipHashSecret: 'x', jwtSigningKey: 'y' }), 'x');
    assert.ok(ipHashSecret({ ipHashSecret: '', jwtSigningKey: 'y' }).length > 0);
    assert.ok(ipHashSecret({ ipHashSecret: '', jwtSigningKey: '' }).length > 0);
});
