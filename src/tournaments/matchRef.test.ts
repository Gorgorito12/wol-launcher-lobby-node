/**
 * "This game was played for a bracket", as every match list sends it. Run: `npm test`.
 *
 * The History built this shape on its own for as long as tournaments existed; the two community
 * lists never sent it, so a final read like a friendly in "Latest matches". The shape is pinned
 * here once so the three lists cannot drift apart again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    tournamentRefOf, withTournamentRef, TOURNAMENT_REF_COLUMNS, TOURNAMENT_REF_JOIN,
} from './matchRef';
import { browseSql, type BrowseFilters } from '../matches/browse';

const NONE: BrowseFilters = {
    limit: 30, cursor: null, q: null, replayOnly: false, mod: null,
    sort: 'newest', days: null, kind: null, decided: false,
};

test('THE ONE THAT MATTERS: a bracket game carries its tournament, round and round count', () => {
    assert.deepEqual(
        tournamentRefOf({
            tournament_id: 'abc12345', tournament_name: 'Copa', tournament_round: 3,
            tournament_bracket_size: 8,
        }),
        { id: 'abc12345', name: 'Copa', round: 3, rounds_total: 3 },
    );
});

test('an ordinary match has no tournament — null, never an empty object', () => {
    assert.equal(tournamentRefOf({}), null);
    assert.equal(tournamentRefOf({ tournament_id: null }), null);
    assert.equal(tournamentRefOf({ tournament_id: '' }), null);
});

test('a bracket not drawn yet, or a round unknown, says null rather than inventing one', () => {
    assert.deepEqual(
        tournamentRefOf({ tournament_id: 't', tournament_name: 'Copa', tournament_bracket_size: null }),
        { id: 't', name: 'Copa', round: null, rounds_total: null },
    );
});

test('the four columns are folded into one field and nothing else on the row moves', () => {
    const row = withTournamentRef({
        id: 'm1', map_name: 'ESOC_Manchac', rated: 1,
        tournament_id: 't', tournament_name: 'Copa', tournament_round: 4, tournament_bracket_size: 16,
    });
    assert.deepEqual(row, {
        id: 'm1', map_name: 'ESOC_Manchac', rated: 1,
        tournament: { id: 't', name: 'Copa', round: 4, rounds_total: 4 },
    });
    assert.ok(!('tournament_id' in row));
});

test('the community match list selects and joins the tournament exactly as the History does', () => {
    const sql = browseSql(NONE).sql;
    assert.ok(sql.includes(TOURNAMENT_REF_COLUMNS));
    assert.ok(sql.includes(TOURNAMENT_REF_JOIN));
    // LEFT, both: an ordinary match must still be listed.
    assert.match(TOURNAMENT_REF_JOIN, /LEFT JOIN tournament_matches tm ON tm\.id = m\.tournament_match_id/);
    assert.match(TOURNAMENT_REF_JOIN, /LEFT JOIN tournaments t ON t\.id = tm\.tournament_id/);
});
