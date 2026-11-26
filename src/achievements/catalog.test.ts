/**
 * The achievements catalogue (design 121). Run: `npm test`.
 *
 * The counts are the design's: Wars of Liberty 36 achievements / 40 medals, The Asian Dynasties
 * 37 / 41 ("Promotion" gives one medal per age). The name keys are what decide whether a stored
 * match counts toward a civilization or map medal at all, so their refusals matter as much as
 * their matches.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    allOf, catalogFor, civKey, mapKey, medalCount, CIV_LISTS, MAP_LISTS, TAD_FAMILIES, TAD_KEY,
} from './catalog';

test('Wars of Liberty has 36 achievements and 40 medals, TAD 37 and 41', () => {
    assert.equal(allOf('wol').length, 36);
    assert.equal(medalCount('wol'), 40);
    assert.equal(allOf(TAD_KEY).length, 37);
    assert.equal(medalCount(TAD_KEY), 41);
});

test('a mod without a civilization list has no "Citizen of the World"', () => {
    const ids = allOf('improvement-mod').map((a) => a.id);
    assert.ok(!ids.includes('citizen_of_the_world'));
    assert.equal(medalCount('improvement-mod'), 39);
});

test('ids are unique within each game', () => {
    for (const mod of ['wol', TAD_KEY, 'other']) {
        const ids = allOf(mod).map((a) => a.id);
        assert.equal(new Set(ids).size, ids.length, mod);
    }
});

test('every group has an enamel colour of the seven', () => {
    for (const mod of ['wol', TAD_KEY]) {
        for (const g of catalogFor(mod)) assert.ok(g.enamel >= 0 && g.enamel <= 6, g.id);
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
