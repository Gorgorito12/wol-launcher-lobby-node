/**
 * Who may see a rating still being placed (src/elo/placementPrivacy.ts). Run: `npm test`.
 *
 * <p>Every redactor is driven with one placed player ("ana", 14 rated 1v1 matches) and one placing
 * player ("pedro", 3 of 10), and asked the same question: does pedro's number reach anybody but
 * pedro? The mirror cases matter as much — pedro still sees his own number, and ana keeps hers —
 * because a rule that hides too much is the one nobody notices until a player reports it.</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    anyPlacing, memberFor, membersFor, participantsFor, presenceFor, publicRatingsFor, ratingHiddenFrom,
    resultParticipantsFor, historyRowFor, standingShownTo, type CurrentGames,
} from './placementPrivacy';

const games: CurrentGames = new Map([
    ['ana', { default: 14, team: 6 }],
    ['pedro', { default: 3, team: 0 }],
    ['luis', { default: 12, team: 2 }],
]);

/** The keys a payload actually sends: JSON drops what a redactor deleted. */
const keysOf = (o: object) => Object.keys(JSON.parse(JSON.stringify(o)) as object);

test('THE ONE THAT MATTERS: a placing player\'s rating never reaches another player', () => {
    // A room member, as the other player in the room receives him.
    const pedroMember = { ready: true, login: 'pedro', rating: 1380, rd: 210, gamesPlayed: 3, gamesPlayedTeam: 0,
        ratingTeam: 1500, rdTeam: 350 };
    const seenByAna = memberFor('pedro', pedroMember, 'ana');
    assert.equal(seenByAna.rating, undefined);
    assert.equal(seenByAna.rd, undefined);
    assert.ok(!keysOf(seenByAna).includes('rating'));

    // The whole roster of a room_state.
    const roster = membersFor({ pedro: pedroMember, ana: { rating: 1610, rd: 80, gamesPlayed: 14 } }, 'ana');
    assert.equal(roster.pedro!.rating, undefined);

    // The rooms list's host and the member_joined broadcast: nobody but him may receive them.
    const host = publicRatingsFor('pedro', { id: 'pedro', rating: 1380, rd: 210, games_played: 3,
        rating_team: 1500, rd_team: 350, games_played_team: 0 });
    assert.ok(!keysOf(host).includes('rating'));
    assert.ok(!keysOf(host).includes('rd'));

    // The players panel.
    const presence = presenceFor({ userId: 'pedro', rating: 1380, rd: 210, ratingTeam: 1500, rdTeam: 350,
        gamesPlayed: 3, gamesPlayedTeam: 0 });
    assert.equal(presence.rating, null);
    assert.equal(presence.rd, null);

    // His standing, asked for by somebody else.
    const standing = standingShownTo({ rating: 1380, rd: 210, volatility: 0.06, games_played: 3, wins: 2 }, 'default', false);
    assert.deepEqual(keysOf(standing).sort(), ['games_played', 'wins']);

    // A stored match, read by ana.
    const [entry] = participantsFor([{ user_id: 'pedro', rating_before: 1340, rating_after: 1380 }], 'default', 'ana', games);
    assert.ok(!keysOf(entry!).includes('rating_before'));
    assert.ok(!keysOf(entry!).includes('rating_after'));

    // The result card of the match he just played, delivered to ana.
    const [result] = resultParticipantsFor([{ user_id: 'pedro', result: 0, rating_before: 1340, rating_after: 1380,
        rd_before: 220, rd_after: 210, placement_played: 4, placement_required: 10 }], 'ana');
    for (const k of ['rating_before', 'rating_after', 'rd_before', 'rd_after']) {
        assert.ok(!keysOf(result!).includes(k), `${k} reached another player`);
    }
});

test('the owner always keeps his own number', () => {
    const pedroMember = { rating: 1380, rd: 210, gamesPlayed: 3 };
    assert.equal(memberFor('pedro', pedroMember, 'pedro').rating, 1380);
    assert.equal(membersFor({ pedro: pedroMember }, 'pedro').pedro!.rating, 1380);
    assert.equal(standingShownTo({ rating: 1380, rd: 210, volatility: 0.06, games_played: 3 }, 'default', true).rating, 1380);
    const [entry] = participantsFor([{ user_id: 'pedro', rating_before: 1340, rating_after: 1380 }], 'default', 'pedro', games);
    assert.equal(entry!.rating_after, 1380);
    const [result] = resultParticipantsFor([{ user_id: 'pedro', rating_after: 1380, placement_played: 4,
        placement_required: 10 }], 'pedro');
    assert.equal(result!.rating_after, 1380);
});

test('a placed player\'s number is untouched, and so is everything that is not the number', () => {
    const ana = { ready: false, login: 'ana', rating: 1610, rd: 80, gamesPlayed: 14, ladderRank: 3 };
    assert.equal(memberFor('ana', ana, 'pedro'), ana, 'nothing to hide: the very same object');
    const host = publicRatingsFor('ana', { id: 'ana', rating: 1610, rd: 80, games_played: 14 });
    assert.equal(host.rating, 1610);
    // Pedro's progress, result and identity stay; only the number goes.
    const [result] = resultParticipantsFor([{ user_id: 'pedro', result: 1, rating_after: 1400,
        placement_played: 4, placement_required: 10 }], 'ana');
    assert.equal((result as { result?: number }).result, 1);
    assert.equal(result!.placement_played, 4);
});

test('the ladders are separate: placing in teams hides only the team number', () => {
    const luis = { rating: 1550, rd: 90, gamesPlayed: 12, ratingTeam: 1490, rdTeam: 200, gamesPlayedTeam: 2 };
    const seen = memberFor('luis', luis, 'ana');
    assert.equal(seen.rating, 1550);
    assert.equal(seen.ratingTeam, undefined);
    assert.equal(seen.rdTeam, undefined);
    const presence = presenceFor({ userId: 'luis', rating: 1550, rd: 90, ratingTeam: 1490, rdTeam: 200,
        gamesPlayed: 12, gamesPlayedTeam: 2 });
    assert.equal(presence.rating, 1550);
    assert.equal(presence.ratingTeam, null);
    // A team match: luis is placing on THAT ladder, so his before/after go.
    const [entry] = participantsFor([{ user_id: 'luis', rating_before: 1470, rating_after: 1490 }], 'team', 'ana', games);
    assert.equal(entry!.rating_after, undefined);
    assert.equal(entry!.in_placement, true);
    assert.equal(entry!.placement_played, 2);
    assert.equal(entry!.placement_required, 5);
});

test('decided by the CURRENT state: once placed, his old placement matches show again', () => {
    const placedNow: CurrentGames = new Map([['pedro', { default: 10, team: 0 }]]);
    const [entry] = participantsFor([{ user_id: 'pedro', rating_before: 1340, rating_after: 1380 }], 'default', 'ana', placedNow);
    assert.equal(entry!.rating_after, 1380);
    assert.equal(entry!.in_placement, false);
    assert.equal(entry!.placement_played, 10);
});

test('the match that FINISHED placement shows the number on its result card', () => {
    const [result] = resultParticipantsFor([{ user_id: 'pedro', rating_after: 1420, placement_played: 10,
        placement_required: 10 }], 'ana');
    assert.equal(result!.rating_after, 1420);
});

test('unknown matches played hides nothing, as before', () => {
    assert.equal(ratingHiddenFrom('ana', 'pedro', undefined, 'default'), false);
    assert.equal(ratingHiddenFrom('ana', 'pedro', null, 'default'), false);
    assert.equal(ratingHiddenFrom('ana', 'pedro', Number.NaN, 'default'), false);
    const member = { rating: 1500, rd: 350 };
    assert.equal(memberFor('pedro', member, 'ana').rating, 1500);
    const [entry] = participantsFor([{ user_id: 'ghost', rating_before: null, rating_after: null }], 'default', 'ana', games);
    assert.ok(!keysOf(entry!).includes('in_placement'));
    assert.equal(entry!.placement_required, 10);
});

test('nobody with no rated match is "placing": an unplayed 1500 is everyone\'s, and shown', () => {
    assert.equal(ratingHiddenFrom('ana', 'newbie', 0, 'default'), false);
});

test('no viewer means everybody but the owner: a shared payload hides him from all', () => {
    assert.equal(ratingHiddenFrom(null, 'pedro', 3, 'default'), true);
    assert.equal(ratingHiddenFrom(undefined, 'pedro', 3, 'default'), true);
    const [entry] = participantsFor([{ user_id: 'pedro', rating_before: 1340, rating_after: 1380 }], 'default', null, games);
    assert.equal(entry!.rating_after, undefined);
    const [result] = resultParticipantsFor([{ user_id: 'pedro', rating_after: 1380, placement_played: 4,
        placement_required: 10 }], null);
    assert.equal(result!.rating_after, undefined);
});

test('a history row is the subject\'s own: withheld from others while he places, never from him', () => {
    const row = { rating_before: 1340, rating_after: 1380, map_name: 'Texas' };
    assert.equal(historyRowFor(row, 'pedro', 'default', 'ana', games).rating_after, undefined);
    assert.equal(historyRowFor(row, 'pedro', 'default', 'ana', games).map_name, 'Texas');
    assert.equal(historyRowFor(row, 'pedro', 'default', 'pedro', games).rating_after, 1380);
    // A placed subject, or the team ladder he is not placing on, shows as before.
    assert.equal(historyRowFor(row, 'ana', 'default', 'pedro', games).rating_after, 1380);
    assert.equal(historyRowFor(row, 'pedro', 'team', 'ana', games).rating_after, 1380);
});

test('redactors never mutate what they were given: it is the room\'s live state', () => {
    const live = { rating: 1380, rd: 210, gamesPlayed: 3 };
    memberFor('pedro', live, 'ana');
    membersFor({ pedro: live }, 'ana');
    assert.equal(live.rating, 1380);
    const list = [{ user_id: 'pedro', rating_after: 1380, placement_played: 4, placement_required: 10 }];
    resultParticipantsFor(list, 'ana');
    assert.equal(list[0]!.rating_after, 1380);
});

test('the odds: anybody placing on the room\'s ladder hides them; the other ladder does not', () => {
    assert.equal(anyPlacing([{ inPlacement: false }, { inPlacement: true }], 'default'), true);
    assert.equal(anyPlacing([{ inPlacement: false }, { inPlacement: false }], 'default'), false);
    // Placing in teams says nothing about a 1v1 room, and the reverse.
    assert.equal(anyPlacing([{ inPlacement: false, inPlacementTeam: true }], 'default'), false);
    assert.equal(anyPlacing([{ inPlacement: true, inPlacementTeam: false }], 'team'), false);
    // Unknown is not placing.
    assert.equal(anyPlacing([{}, {}], 'default'), false);
});
