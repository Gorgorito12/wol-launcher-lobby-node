import test from 'node:test';
import assert from 'node:assert/strict';

import { applyLanAuto, readLanAuto } from './lanAuto';

/** The per-member "enters the LAN room by itself" flag. Anything but a real boolean is ignored. */

test('only a boolean is read', () => {
    assert.equal(readLanAuto({ type: 'set_lan_auto', auto: true }), true);
    assert.equal(readLanAuto({ type: 'set_lan_auto', auto: false }), false);
    assert.equal(readLanAuto({ type: 'set_lan_auto', auto: 'true' }), null);
    assert.equal(readLanAuto({ type: 'set_lan_auto', auto: 1 }), null);
    assert.equal(readLanAuto({ type: 'set_lan_auto' }), null);
});

test('a change is applied once and a repeat is not', () => {
    const member: { lanAuto?: boolean } = {};
    assert.equal(applyLanAuto(member, true), true);
    assert.equal(member.lanAuto, true);
    assert.equal(applyLanAuto(member, true), false);
    assert.equal(applyLanAuto(member, false), true);
    assert.equal(member.lanAuto, false);
});

test('a member who is not in the room changes nothing', () => {
    assert.equal(applyLanAuto(undefined, true), false);
});
