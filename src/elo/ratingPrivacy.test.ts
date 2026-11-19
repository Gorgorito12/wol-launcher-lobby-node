import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetRatingPrivacyForTests, setRatingPrivate, isRatingPrivate } from './ratingPrivacy';
import {
    memberFor, publicRatingsFor, presenceFor, standingShownTo, resultParticipantsFor, participantsFor,
} from './placementPrivacy';
import { roomOdds } from '../lobbies/roomTeams';

beforeEach(() => resetRatingPrivacyForTests());

const placed = { rating: 1600, rd: 60, ratingTeam: 1500, rdTeam: 70, gamesPlayed: 40, gamesPlayedTeam: 30 };

test('THE ONE THAT MATTERS: a private rating reaches nobody but its owner', () => {
    setRatingPrivate('u1', true);
    const other = memberFor('u1', placed, 'u2');
    assert.equal('rating' in other, false);
    assert.equal('ratingTeam' in other, false);
    assert.equal(memberFor('u1', placed, 'u1').rating, 1600, 'he still sees his own');
    const pub = publicRatingsFor('u1', { rating: 1600, rd: 60, games_played: 40, rating_team: 1500, rd_team: 70, games_played_team: 30 });
    assert.equal('rating' in pub, false);
    assert.equal(presenceFor({ userId: 'u1', rating: 1600, rd: 60, ratingTeam: 1500, rdTeam: 70, gamesPlayed: 40, gamesPlayedTeam: 30 }).rating, null);
});

test('a shown rating is untouched once placed, and switching back shows it again', () => {
    assert.equal(memberFor('u1', placed, 'u2').rating, 1600);
    setRatingPrivate('u1', true);
    setRatingPrivate('u1', false);
    assert.equal(isRatingPrivate('u1'), false);
    assert.equal(memberFor('u1', placed, 'u2').rating, 1600);
});

test('the standing loses its number, peak, low and place for anybody else', () => {
    const s = { rating: 1600, rd: 60, volatility: 0.06, games_played: 40, rating_peak: 1700, rating_peak_at: 'x',
        rating_low: 1400, rating_low_at: 'y', ladder_rank: 3, wins: 30 };
    const shown = standingShownTo(s, 'default', false, true) as Record<string, unknown>;
    for (const k of ['rating', 'rd', 'volatility', 'rating_peak', 'rating_peak_at', 'rating_low', 'rating_low_at', 'ladder_rank'])
        assert.equal(k in shown, false, k);
    assert.equal(shown.wins, 30, 'the record stays public');
    assert.equal(standingShownTo(s, 'default', true, true).rating, 1600);
});

test('results and history carry no before/after of a private player', () => {
    setRatingPrivate('u1', true);
    const r = resultParticipantsFor([{ user_id: 'u1', rating_before: 1500, rating_after: 1512 }], 'u2')[0] as Record<string, unknown>;
    assert.equal('rating_before' in r, false);
    const games = new Map([['u1', { default: 40, team: 0 }]]);
    const h = participantsFor([{ user_id: 'u1', rating_before: 1500, rating_after: 1512 }], 'default', 'u2', games)[0] as Record<string, unknown>;
    assert.equal('rating_after' in h, false);
});

test('a room with a private player shows no odds', () => {
    setRatingPrivate('a', true);
    const odds = roomOdds(2, [
        { id: 'a', rating: 1600, rd: 60, team: null } as never,
        { id: 'b', rating: 1500, rd: 60, team: null } as never,
    ]);
    assert.equal(odds.players, null);
    assert.equal(odds.hidden_reason, 'private');
});

test('THE ONE THAT MATTERS: win_expected belongs to its owner alone — no other recipient ever gets it', () => {
    const list = [
        { user_id: 'a', rating_before: 1600, rating_after: 1610, win_expected: 72, placement_played: 10, placement_required: 10 },
        { user_id: 'b', rating_before: 1500, rating_after: 1490, win_expected: 28, placement_played: 10, placement_required: 10 },
    ];
    const forA = resultParticipantsFor(list, 'a') as Array<Record<string, unknown>>;
    assert.equal(forA[0]!.win_expected, 72);
    assert.equal('win_expected' in forA[1]!, false);
    const forNobody = resultParticipantsFor(list, null) as Array<Record<string, unknown>>;
    assert.ok(forNobody.every((p) => !('win_expected' in p)));
});
