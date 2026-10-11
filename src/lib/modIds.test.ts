/**
 * Mod-id lists: the rule shared by RANKED_MOD_IDS and the per-webhook Discord filter
 * (DISCORD_WEBHOOK_MOD_IDS). Run: `npm test`.
 *
 * <p>The webhook filter is positional, like the role pings. The case that matters is the
 * webhook nobody wrote a slot for: one appended to DISCORD_WEBHOOK_URL later must announce
 * EVERY mod, never inherit the filter chosen for the webhooks that existed before it.</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { modIdInList, modsForWebhook, parseModSlots, ALL_MODS } from './modIds';

function announces(raw: string | undefined, webhook: number, mod: string): boolean {
    return modIdInList(modsForWebhook(parseModSlots(raw), webhook), mod);
}

test('THE ONE THAT MATTERS: the webhooks with a slot show WoL only, a webhook added later shows every mod', () => {
    const raw = 'wol,wol';
    for (const webhook of [0, 1]) {
        assert.equal(announces(raw, webhook, 'wol'), true, `webhook ${webhook} wol`);
        assert.equal(announces(raw, webhook, 'improvement-mod'), false, `webhook ${webhook} improvement-mod`);
        assert.equal(announces(raw, webhook, 'aoe3-tad'), false, `webhook ${webhook} aoe3-tad`);
    }
    for (const mod of ['wol', 'improvement-mod', 'aoe3-tad', 'a-mod-added-next-year']) {
        assert.equal(announces(raw, 2, mod), true, `webhook 2 (added later) ${mod}`);
    }
});

test('unset or blank: every webhook announces every mod, as before the filter existed', () => {
    for (const raw of [undefined, '', '   ']) {
        assert.deepEqual(parseModSlots(raw), []);
        assert.equal(announces(raw, 0, 'improvement-mod'), true);
        assert.equal(announces(raw, 3, 'wol'), true);
    }
});

test('an empty slot or `*` means every mod; slots stay positional across a blank', () => {
    assert.deepEqual(parseModSlots('wol,,wol'), [['wol'], [ALL_MODS], ['wol']]);
    assert.equal(announces('wol,,wol', 1, 'improvement-mod'), true);
    assert.equal(announces('wol,,wol', 2, 'improvement-mod'), false, 'the slot after the blank keeps its own filter');
    assert.equal(announces('wol,*', 1, 'aoe3-tad'), true);
});

test('a slot can name several mods, in any case and spacing', () => {
    assert.deepEqual(parseModSlots(' WoL + Improvement-Mod ,aoe3-tad|wol'), [['wol', 'improvement-mod'], ['aoe3-tad', 'wol']]);
    assert.equal(announces('wol+improvement-mod', 0, 'improvement-mod'), true);
    assert.equal(announces('wol+improvement-mod', 0, 'aoe3-tad'), false);
    assert.equal(announces('wol', 0, ' WoL '), true);
});

test('modIdInList: `*` matches every real mod, a list matches its own ids only', () => {
    assert.equal(modIdInList([ALL_MODS], 'a-mod-added-next-year'), true);
    assert.equal(modIdInList(['wol', 'improvement-mod'], 'improvement-mod'), true);
    assert.equal(modIdInList(['wol'], 'wol-extra'), false);
});

test('modIdInList: an empty list matches nothing, and a missing mod id is never matched — not even by `*`', () => {
    assert.equal(modIdInList([], 'wol'), false);
    for (const missing of ['', '   ', null, undefined]) {
        assert.equal(modIdInList([ALL_MODS], missing), false, String(missing));
        assert.equal(modIdInList(['wol'], missing), false, String(missing));
    }
});
