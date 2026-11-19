/**
 * Civilizations that arrive by confirmation. Run: `npm test`.
 *
 * Same split as `ladder.test.ts`: there is no database harness here, so what is pinned is
 * the decision — what a confirmation is allowed to say, and the guard on the UPDATE that
 * writes it — rather than the round trip, which is checked against a real database on
 * deploy (DEPLOY.md, "Civilizations by confirmation").
 *
 * The bug this exists for, from the live server the day it was written: 43 of 44 matches
 * had no civilization, including every one played that morning, because the only thing
 * that ever wrote `match_participants.civ` was the host's first-pass report, which goes
 * out before the recording exists. Migration 0019 has the story.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    sanitiseNameMap, NAME_MAP_MAX_LEN, FILL_CIV_SQL, FILL_HOME_CITY_SQL, mergeNameMaps, civsFromReadings,
    planCivBackfill,
} from './rest';

const ROSTER = new Set(['host', 'guest']);

test('THE ONE THAT MATTERS: a reading names the players who were in the room, and only them', () => {
    // Somebody outside the roster is not an error — the whole reading is not refused over
    // it — it is a claim about a player this match never had, and it is dropped.
    const kept = sanitiseNameMap(
        { host: 'Ethiopians', guest: 'Zulu', stranger: 'Dutch' }, ROSTER);
    assert.deepEqual(kept, { host: 'Ethiopians', guest: 'Zulu' });
});

test('values are trimmed, blanks are dropped, and nothing is longer than the cap', () => {
    const kept = sanitiseNameMap(
        { host: '  Ethiopians  ', guest: '   ', }, ROSTER);
    assert.deepEqual(kept, { host: 'Ethiopians' });

    const long = 'x'.repeat(NAME_MAP_MAX_LEN + 40);
    const capped = sanitiseNameMap({ host: long }, ROSTER);
    assert.equal(capped.host.length, NAME_MAP_MAX_LEN);
});

test('anything that is not a map of strings is an empty reading, not an error', () => {
    // A launcher older than the field sends nothing at all; a broken one might send a list
    // or a number. Neither may cost the confirmation its RESULT, which is the part that
    // decides matches.
    assert.deepEqual(sanitiseNameMap(undefined, ROSTER), {});
    assert.deepEqual(sanitiseNameMap(null, ROSTER), {});
    assert.deepEqual(sanitiseNameMap(['Ethiopians'], ROSTER), {});
    assert.deepEqual(sanitiseNameMap('Ethiopians', ROSTER), {});
    assert.deepEqual(sanitiseNameMap({ host: 7, guest: { civ: 'Zulu' } }, ROSTER), {});
});

test('the UPDATE fills gaps and never overwrites', () => {
    // The guard is the rule: the host's report outranks every later reading, and two
    // confirmations that disagree leave the first one standing. A tidy-up that drops the
    // predicate to "just set it" would let a confirmer repaint a decided match.
    for (const sql of [FILL_CIV_SQL, FILL_HOME_CITY_SQL]) {
        assert.match(sql, /^UPDATE match_participants SET (civ|home_city) = \?/);
        assert.match(sql, /WHERE match_id = \? AND user_id = \?/);
        assert.match(sql, /IS NULL OR TRIM\((civ|home_city)\) = ''/);
        // Exactly three placeholders, in the order fillMissingCivs binds them: value, match, user.
        assert.equal(sql.match(/\?/g)?.length, 3);
    }
});

test('merging two readings keeps what the first said and adds only what it lacked', () => {
    assert.deepEqual(
        mergeNameMaps({ host: 'Ethiopians' }, { host: 'Zulu', guest: 'Dutch' }),
        { host: 'Ethiopians', guest: 'Dutch' });
    assert.deepEqual(mergeNameMaps({}, {}), {});
});

test('THE ONE THAT MATTERS: a founded match takes every reading, the founder first', () => {
    // The founder is the side that conceded and usually named only itself; the winner's own
    // reading, stored earlier, used to be ignored.
    const readings = [
        { user_id: 'winner', civs: JSON.stringify({ winner: 'Spanish', loser: 'British' }), home_cities: null, created_at: '2026-11-18 20:00:00' },
        { user_id: 'loser', civs: JSON.stringify({ loser: 'Ottomans' }), home_cities: JSON.stringify({ loser: 'Istanbul' }), created_at: '2026-11-18 20:01:00' },
    ];
    const merged = civsFromReadings(readings, 'loser');
    assert.deepEqual(merged.civs, { loser: 'Ottomans', winner: 'Spanish' });
    assert.deepEqual(merged.homeCities, { loser: 'Istanbul' });
});

test('the backfill fills blank cells only, from the oldest reading first', () => {
    const fills = planCivBackfill(
        [
            { user_id: 'a', civ: 'Spanish', home_city: null },
            { user_id: 'b', civ: null, home_city: '  ' },
        ],
        [
            { user_id: 'b', civs: JSON.stringify({ a: 'British', b: 'Dutch' }), home_cities: JSON.stringify({ b: 'Amsterdam' }), created_at: '2026-11-18 20:00:00' },
            { user_id: 'a', civs: JSON.stringify({ b: 'Ottomans' }), home_cities: null, created_at: '2026-11-18 20:05:00' },
        ]);
    // a's civ is already stored and stays; b's blanks are filled from the first reading.
    assert.deepEqual(fills, [
        { userId: 'b', field: 'civ', value: 'Dutch' },
        { userId: 'b', field: 'home_city', value: 'Amsterdam' },
    ]);
    assert.deepEqual(planCivBackfill([{ user_id: 'a', civ: 'X', home_city: 'Y' }], []), []);
});

test('readings with nothing, or with broken JSON, add nothing', () => {
    const merged = civsFromReadings([
        { user_id: 'a', civs: null, home_cities: null, created_at: '2026-11-18 20:00:00' },
        { user_id: 'b', civs: '{not json', home_cities: '[]', created_at: '2026-11-18 20:00:01' },
    ], 'a');
    assert.deepEqual(merged, { civs: {}, homeCities: {} });
});
