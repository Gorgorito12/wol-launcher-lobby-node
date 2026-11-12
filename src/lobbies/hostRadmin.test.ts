import test from 'node:test';
import assert from 'node:assert/strict';

import { hostRadminIps, type HostRadminRoom, type HostRadminRow } from './hostRadmin';

/**
 * The rooms list's per-host ping. The address may only reach a player who could have read it by
 * joining the room, so nearly every case here is a refusal.
 */

const row = (id: string, over: Partial<HostRadminRow> = {}): HostRadminRow => ({
    id,
    host_user_id: 'h',
    status: 'open',
    is_private: 0,
    tournament_match_id: null,
    ...over,
});

const room = (ip?: string, host = 'h'): HostRadminRoom => ({
    hostUserId: host,
    members: { [host]: { radminIp: ip }, guest: { radminIp: '26.9.9.9' } },
});

test('a public room whose host is on Radmin gives his address', () => {
    const got = hostRadminIps([row('A')], () => room('26.1.2.3'));
    assert.deepEqual(got, { A: '26.1.2.3' });
});

test('a private room never gives its host away', () => {
    assert.deepEqual(hostRadminIps([row('A', { is_private: 1 })], () => room('26.1.2.3')), {});
});

test('a tournament room never gives its host away', () => {
    assert.deepEqual(hostRadminIps([row('A', { tournament_match_id: 'm1' })], () => room('26.1.2.3')), {});
});

test('a closed room gives nothing, a room in game still does', () => {
    assert.deepEqual(hostRadminIps([row('A', { status: 'closed' })], () => room('26.1.2.3')), {});
    assert.deepEqual(hostRadminIps([row('B', { status: 'in_game' })], () => room('26.1.2.3')), { B: '26.1.2.3' });
});

test('a room with no live instance gives nothing', () => {
    assert.deepEqual(hostRadminIps([row('A')], () => undefined), {});
});

test('a host who has not reported an address gives nothing, and a guest\'s is never used instead', () => {
    assert.deepEqual(hostRadminIps([row('A')], () => room(undefined)), {});
});

test('an address outside 26.0.0.0/8 is refused', () => {
    for (const ip of ['192.168.1.5', '10.26.0.1', '26.1.2', '', ' 26.1.2.3']) {
        assert.deepEqual(hostRadminIps([row('A')], () => room(ip)), {}, ip);
    }
});

test('the live room\'s host decides, not the row\'s', () => {
    // The host left and the room handed itself on before the row was rewritten.
    const handedOn: HostRadminRoom = { hostUserId: 'next', members: { next: { radminIp: '26.5.5.5' } } };
    assert.deepEqual(hostRadminIps([row('A', { host_user_id: 'gone' })], () => handedOn), { A: '26.5.5.5' });
});
