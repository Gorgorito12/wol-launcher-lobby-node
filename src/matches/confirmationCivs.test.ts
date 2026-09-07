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
import { sanitiseNameMap, NAME_MAP_MAX_LEN, FILL_CIV_SQL, FILL_HOME_CITY_SQL } from './rest';

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
