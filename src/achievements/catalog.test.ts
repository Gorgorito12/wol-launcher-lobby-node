/**
 * The achievements catalogue (design 121). Run: `npm test`.
 *
 * The design's counts were Wars of Liberty 36 achievements / 40 medals and The Asian Dynasties
 * 37 / 41 ("Promotion" gives one medal per age); the medals added on 2026-11-26 bring them to
 * 59 / 63 and 48 / 52, and the platinum feats to 68 / 72 and 57 / 61. The name keys are what decide whether a stored
 * match counts toward a civilization or map medal at all, so their refusals matter as much as
 * their matches.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    allOf, catalogFor, civKey, collectorGoal, mapKey, medalCount, CIV_LISTS, MAP_LISTS, TAD_FAMILIES, TAD_KEY, WOL_CONTINENTS,
} from './catalog';

test('Wars of Liberty has 68 achievements and 72 medals, TAD 57 and 61', () => {
    assert.equal(allOf('wol').length, 68);
    assert.equal(medalCount('wol'), 72);
    assert.equal(allOf(TAD_KEY).length, 57);
    assert.equal(medalCount(TAD_KEY), 61);
});

test("Wars of Liberty's four continents are its 48 civilizations, each once", () => {
    const all = Object.values(WOL_CONTINENTS).flat();
    assert.equal(all.length, 48);
    assert.equal(new Set(all).size, 48);
    for (const k of all) assert.ok(CIV_LISTS.wol!.includes(k), k);
});

test("every civilization a Wars of Liberty war names is one the mod has", () => {
    const wars = catalogFor('wol').find((g) => g.id === 'historical_wars')!;
    assert.equal(wars.items.length, 8);
    for (const def of wars.items) {
        assert.equal(def.rule.kind, 'matchup_win');
        if (def.rule.kind !== 'matchup_win') continue;
        for (const side of [def.rule.mine, def.rule.theirs]) {
            assert.ok(Array.isArray(side) && side.length > 0, def.id);
            for (const k of side as readonly string[]) assert.ok(CIV_LISTS.wol!.includes(k), `${def.id}: ${k}`);
        }
    }
});

test('only Wars of Liberty has the continents and the wars', () => {
    for (const mod of [TAD_KEY, 'improvement-mod']) {
        const ids = allOf(mod).map((a) => a.id);
        assert.ok(!ids.includes('africa_oceania') && !ids.includes('war_pacific'), mod);
    }
});

test('a mod without a civilization list has no "Citizen of the World"', () => {
    const ids = allOf('improvement-mod').map((a) => a.id);
    assert.ok(!ids.includes('citizen_of_the_world'));
    assert.equal(allOf('improvement-mod').length, 55);
    assert.equal(medalCount('improvement-mod'), 59);
});

test('ids are unique within each game', () => {
    for (const mod of ['wol', TAD_KEY, 'other']) {
        const ids = allOf(mod).map((a) => a.id);
        assert.equal(new Set(ids).size, ids.length, mod);
    }
});

test('every group has an enamel colour of the seven', () => {
    for (const mod of ['wol', TAD_KEY]) {
        for (const g of catalogFor(mod)) assert.ok(g.enamel >= 0 && g.enamel <= 7, g.id);
    }
});

test("TAD's families are 8 European, 3 native and 3 Asian, 14 in all", () => {
    assert.equal(TAD_FAMILIES.european.length, 8);
    assert.equal(TAD_FAMILIES.native.length, 3);
    assert.equal(TAD_FAMILIES.asian.length, 3);
    assert.equal(new Set([...TAD_FAMILIES.european, ...TAD_FAMILIES.native, ...TAD_FAMILIES.asian]).size, 14);
});

test('a Spanish TAD install names the same civilizations', () => {
    assert.equal(civKey('Españoles'), 'spanish');
    assert.equal(civKey('Británicos'), 'british');
    assert.equal(civKey('Iroqueses'), 'iroquois');
    assert.equal(civKey('Indios'), 'indians');
    assert.equal(civKey('Japoneses'), 'japanese');
});

test("Wars of Liberty's list matches the names its own players send", () => {
    // The WoL launcher sends the English display names; aliases must not move them off the list.
    for (const name of ['Haudenosaunee', 'Lakota', 'United States', 'Austro-Hungarians', 'Danes']) {
        assert.ok(CIV_LISTS.wol!.includes(civKey(name)), name);
    }
    assert.equal(CIV_LISTS.wol!.length, 48);
    assert.equal(new Set(CIV_LISTS.wol).size, 48);
});

test('a missing civilization has no key and never counts', () => {
    assert.equal(civKey(null), '');
    assert.equal(civKey('   '), '');
});

test('map names lose their pack prefix, their size and their spelling', () => {
    assert.equal(mapKey('ESOC_Baja California'), 'bajacalifornia');
    assert.equal(mapKey('ESOC Yukon'), 'yukon');
    assert.equal(mapKey('great plainsLarge'), 'greatplains');
    assert.equal(mapKey('silkRoad'), 'silkroad');
    assert.equal(mapKey('himalayasUpper'), 'himalayas');
    assert.equal(mapKey('Great_Plains'), 'greatplains');
    assert.equal(mapKey(null), '');
});

test("a lowercase map is not mistaken for a pack prefix", () => {
    // "amazonia" has no capitals before a separator: nothing is stripped.
    assert.equal(mapKey('amazonia'), 'amazonia');
    assert.equal(mapKey('new england'), 'newengland');
});

test("TAD's Asian maps are the ten of the expansion", () => {
    assert.equal(MAP_LISTS.tad_asian.length, 10);
    assert.ok(MAP_LISTS.tad_asian.includes(mapKey('yellow riverDry')));
});

test('every game ends on the platinum feats, and only they are platinum', () => {
    for (const mod of ['wol', TAD_KEY, 'improvement-mod']) {
        const groups = catalogFor(mod);
        const feats = groups[groups.length - 1]!;
        assert.equal(feats.id, 'feats', mod);
        assert.equal(feats.items.length, 9, mod);
        for (const g of groups) for (const i of g.items) assert.equal(i.metal === 'p', g.id === 'feats', `${mod}: ${i.id}`);
    }
});

test("Living Legend asks three in four of the game's other medals", () => {
    assert.equal(collectorGoal('wol'), 54);
    assert.equal(collectorGoal(TAD_KEY), 45);
    assert.equal(collectorGoal('improvement-mod'), 44);
});
