/**
 * Teams in the room: who may move whom, when a competitive room may start, and its odds.
 * Run: `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTeam, roomOdds, startRefusal, teamCapacity, teamsAtStart, validateTeamChange } from './roomTeams';

const members = {
    host: { team: 1 as const, role: 'player' },
    ana: { team: 1 as const, role: 'player' },
    luis: { team: null, role: 'player' },
    spec: { team: null, role: 'spectator' },
};

test('only 2v2 and 3v3 rooms have teams', () => {
    assert.equal(teamCapacity(2), 0);
    assert.equal(teamCapacity(4), 2);
    assert.equal(teamCapacity(6), 3);
    assert.equal(teamCapacity(5), 0);
});

test('a player picks his own team; the host may move anybody; nobody else may', () => {
    const base = { hostId: 'host', playingSeats: 4, members, inGame: false };
    assert.equal(validateTeamChange({ ...base, actorId: 'luis', targetId: 'luis', team: 2 }), null);
    assert.equal(validateTeamChange({ ...base, actorId: 'host', targetId: 'luis', team: 2 }), null);
    assert.equal(validateTeamChange({ ...base, actorId: 'ana', targetId: 'luis', team: 2 }), 'forbidden');
});

test('refusals: full team, spectators, bad value, mid-game, no teams in a 1v1', () => {
    const base = { hostId: 'host', playingSeats: 4, members, inGame: false };
    assert.equal(validateTeamChange({ ...base, actorId: 'luis', targetId: 'luis', team: 1 }), 'team_full');
    assert.equal(validateTeamChange({ ...base, actorId: 'host', targetId: 'spec', team: 2 }), 'spectator_no_team');
    assert.equal(validateTeamChange({ ...base, actorId: 'luis', targetId: 'luis', team: undefined }), 'bad_team');
    assert.equal(validateTeamChange({ ...base, actorId: 'luis', targetId: 'luis', team: 2, inGame: true }), 'game_in_progress');
    assert.equal(validateTeamChange({ ...base, actorId: 'luis', targetId: 'luis', team: 2, playingSeats: 2 }), 'team_not_supported');
    assert.equal(validateTeamChange({ ...base, actorId: 'host', targetId: 'ghost', team: 2 }), 'not_in_room');
    // Leaving the teams is always allowed.
    assert.equal(validateTeamChange({ ...base, actorId: 'ana', targetId: 'ana', team: null }), null);
});

test('parseTeam accepts 1, 2 and null and nothing else', () => {
    assert.equal(parseTeam(1), 1);
    assert.equal(parseTeam('2'), 2);
    assert.equal(parseTeam(null), null);
    assert.equal(parseTeam(3), undefined);
    assert.equal(parseTeam(undefined), undefined);
});

test('THE ONE THAT MATTERS: start refusals, in order — missing players, no team, uneven', () => {
    const base = { competitive: true, playingSeats: 4, hostUnderstands: true, teamsEnforced: true };
    assert.deepEqual(
        startRefusal({ ...base, players: [{ id: 'a', team: null }, { id: 'b', team: 1 }, { id: 'c', team: 1 }] }),
        { code: 'start_missing_players', have: 3, need: 4 },
        'a room that is not full is refused before anything else');
    assert.deepEqual(
        startRefusal({ ...base, players: [{ id: 'a', team: null }, { id: 'b', team: 1 }, { id: 'c', team: 1 }, { id: 'd', team: 1 }] }),
        { code: 'start_player_without_team', user_ids: ['a'] },
        'then somebody with no team, even though the teams are also uneven');
    assert.deepEqual(
        startRefusal({ ...base, players: [{ id: 'a', team: 1 }, { id: 'b', team: 1 }, { id: 'c', team: 1 }, { id: 'd', team: 2 }] }),
        { code: 'start_uneven_teams', team1: 3, team2: 1 });
    assert.equal(
        startRefusal({ ...base, players: [{ id: 'a', team: 1 }, { id: 'b', team: 2 }, { id: 'c', team: 1 }, { id: 'd', team: 2 }] }),
        null);
});

test('casual rooms start as they always did, uneven or not', () => {
    assert.equal(startRefusal({
        competitive: false, playingSeats: 4, hostUnderstands: true, teamsEnforced: true,
        players: [{ id: 'a', team: 1 }, { id: 'b', team: 1 }, { id: 'c', team: 1 }],
    }), null);
});

test('older launchers are never asked for what they cannot do', () => {
    // A player without room-teams support: the team checks do not apply, only the headcount.
    const players = [{ id: 'a', team: null }, { id: 'b', team: null }, { id: 'c', team: null }, { id: 'd', team: null }];
    assert.equal(startRefusal({ competitive: true, playingSeats: 4, hostUnderstands: true, teamsEnforced: false, players }), null);
    // An old HOST cannot read a refusal at all: nothing is refused.
    assert.equal(startRefusal({ competitive: true, playingSeats: 4, hostUnderstands: false, teamsEnforced: false,
        players: players.slice(0, 2) }), null);
});

test('a competitive 1v1 needs both seats taken', () => {
    assert.deepEqual(
        startRefusal({ competitive: true, playingSeats: 2, hostUnderstands: true, teamsEnforced: true, players: [{ id: 'a' }] }),
        { code: 'start_missing_players', have: 1, need: 2 });
});

test('the odds: per player in a 1v1, per team in a team room, null until both sides exist', () => {
    const one = roomOdds(2, [{ id: 'a', rating: 1700, rd: 80 }, { id: 'b', rating: 1500, rd: 80 }]);
    assert.equal(one.mode, 'default');
    assert.ok(one.players!.a! > 50 && one.players!.a! + one.players!.b! === 100);
    assert.equal(roomOdds(2, [{ id: 'a', rating: 1700, rd: 80 }]).players, null);

    const teams = roomOdds(4, [
        { id: 'a', team: 1, ratingTeam: 1500, rdTeam: 100 },
        { id: 'b', team: 2, ratingTeam: 1500, rdTeam: 100 },
        { id: 'c', team: null, ratingTeam: 2000, rdTeam: 100 },
    ]);
    assert.deepEqual(teams.teams, { '1': 50, '2': 50 }, 'a player with no team does not count');
    assert.equal(roomOdds(4, [{ id: 'a', team: 1, ratingTeam: 1500, rdTeam: 100 }]).teams, null);
});

test('the teams frozen at Start, or null when the room did not use them', () => {
    assert.deepEqual(teamsAtStart(4, true, [{ id: 'a', team: 1 }, { id: 'b', team: 2 }]), { a: 1, b: 2 });
    assert.equal(teamsAtStart(2, true, [{ id: 'a', team: 1 }, { id: 'b', team: 2 }]), null);
    assert.equal(teamsAtStart(4, false, [{ id: 'a', team: 1 }, { id: 'b', team: 2 }]), null);
    assert.equal(teamsAtStart(4, true, [{ id: 'a', team: 1 }, { id: 'b', team: null }]), null);
});
