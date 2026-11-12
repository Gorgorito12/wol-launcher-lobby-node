/** The recording's sides against the room's. Run: `npm test`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoomTeams, sidesFromParticipants, sidesFromRoomTeams, teamsMismatch } from './teamsMismatch';

const room = { ana: 1, luis: 1, pedro: 2, sara: 2 };

test('the same partition matches, whatever number each side wore', () => {
    assert.equal(teamsMismatch([
        { user_id: 'ana', team: 2 }, { user_id: 'luis', team: 2 },
        { user_id: 'pedro', team: 1 }, { user_id: 'sara', team: 1 },
    ], room), false);
});

test('THE ONE THAT MATTERS: a different partition is a mismatch', () => {
    assert.equal(teamsMismatch([
        { user_id: 'ana', team: 1 }, { user_id: 'pedro', team: 1 },
        { user_id: 'luis', team: 2 }, { user_id: 'sara', team: 2 },
    ], room), true);
});

test('no room teams, or a recording that misses a player: never refused on a guess', () => {
    assert.equal(teamsMismatch([{ user_id: 'ana', team: 1 }, { user_id: 'luis', team: 2 }], null), false);
    assert.equal(teamsMismatch([
        { user_id: 'ana', team: 1 }, { user_id: 'luis', team: 1 }, { user_id: 'pedro', team: 2 },
    ], room), false);
});

test('parsing the stored JSON', () => {
    assert.deepEqual(parseRoomTeams('{"a":1,"b":2,"c":3}'), { a: 1, b: 2 });
    assert.equal(parseRoomTeams('nope'), null);
    assert.equal(parseRoomTeams(null), null);
});

test('the line-ups for the card: in-game sides and room sides, as id lists', () => {
    assert.deepEqual(sidesFromParticipants([
        { user_id: 'pedro', team: 2 }, { user_id: 'ana', team: 1 }, { user_id: 'sara', team: 2 }, { user_id: 'luis', team: 1 },
    ]), [['ana', 'luis'], ['pedro', 'sara']]);
    assert.deepEqual(sidesFromRoomTeams(room), [['ana', 'luis'], ['pedro', 'sara']]);
});
