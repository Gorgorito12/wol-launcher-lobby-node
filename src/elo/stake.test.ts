import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { matchStakes, roomStakeFor, stakeHiddenFrom } from './stake';
import { rateOutcome } from './outcome';
import { resetRatingPrivacyForTests, setRatingPrivate } from './ratingPrivacy';
import { FARM_RECOVERY_MS } from './antifarm';
import type { SidePlayer } from './glicko2';

beforeEach(() => resetRatingPrivacyForTests());

const kaiser: SidePlayer = { id: 'k', rating: 1630, rd: 60, volatility: 0.06 };
const gorgo: SidePlayer = { id: 'g', rating: 1383, rd: 70, volatility: 0.06 };
const now = Date.UTC(2026, 10, 18, 20, 0, 0);
const base = { mode: 'default' as const, sideA: [kaiser], sideB: [gorgo], prev: null, atMs: now, isTournament: false };
const placed = [{ id: 'k', gamesPlayed: 40 }, { id: 'g', gamesPlayed: 40 }];

test('THE ONE THAT MATTERS: the stake is the result — each branch equals what rateOutcome gives for that score', () => {
    const stakes = matchStakes(base);
    const kWins = rateOutcome({ ...base, scoreA: 1, scoreB: 0 });
    const gWins = rateOutcome({ ...base, scoreA: 0, scoreB: 1 });
    assert.equal(stakes.get('k')!.win.after, kWins.perPlayer.get('k')!.after);
    assert.equal(stakes.get('k')!.loss.after, gWins.perPlayer.get('k')!.after);
    assert.equal(stakes.get('g')!.win.after, gWins.perPlayer.get('g')!.after);
    assert.equal(stakes.get('g')!.loss.after, kWins.perPlayer.get('g')!.after);
    // The favourite stands to win less than he can lose.
    const k = stakes.get('k')!;
    assert.ok(k.win.after - k.before < k.before - k.loss.after);
    assert.equal(k.winPct! + stakes.get('g')!.winPct!, 100);
});

test('THE ONE THAT MATTERS: a rival in placement or private never gets his rating back through MY stake', () => {
    const stakes = matchStakes(base);
    const placing = [{ id: 'k', gamesPlayed: 40 }, { id: 'g', gamesPlayed: 3 }];
    const forK = roomStakeFor('k', stakes, placing, 'default', { tournament: false, seq: 4 })!;
    assert.deepEqual(Object.keys(forK).sort(), ['hidden_reason', 'mode', 'seq']);
    assert.equal(forK.hidden_reason, 'placement');

    setRatingPrivate('k', true);
    const forG = roomStakeFor('g', stakes, placed, 'default', { tournament: false })!;
    assert.deepEqual(Object.keys(forG).sort(), ['hidden_reason', 'mode']);
    assert.equal(forG.hidden_reason, 'private');
});

test('the one placing still sees his own stake when everybody else is public', () => {
    const stakes = matchStakes(base);
    const placing = [{ id: 'k', gamesPlayed: 40 }, { id: 'g', gamesPlayed: 3 }];
    const forG = roomStakeFor('g', stakes, placing, 'default', { tournament: false })!;
    assert.equal(forG.hidden_reason, undefined);
    assert.equal(typeof forG.win_after, 'number');
    setRatingPrivate('g', true);
    assert.equal(roomStakeFor('g', stakes, placed, 'default', { tournament: false })!.hidden_reason, undefined);
});

test('a teammate in placement hides it too', () => {
    const players = [{ id: 'a', gamesPlayed: 30 }, { id: 'b', gamesPlayed: 2 }, { id: 'c', gamesPlayed: 30 }, { id: 'd', gamesPlayed: 30 }];
    assert.equal(stakeHiddenFrom('a', players, 'team'), 'placement');
    assert.equal(stakeHiddenFrom('b', players, 'team'), null);
});

test('private is named before placement', () => {
    setRatingPrivate('c', true);
    const players = [{ id: 'a', gamesPlayed: 30 }, { id: 'b', gamesPlayed: 2 }, { id: 'c', gamesPlayed: 30 }];
    assert.equal(stakeHiddenFrom('a', players, 'team'), 'private');
});

test('anti-farm depends on WHO wins: my third win in a row is 90 %, my loss is full', () => {
    const prev = { atMs: now - 60_000, streak: 2, winnerKey: 'k' };
    const stakes = matchStakes({ ...base, prev });
    const k = stakes.get('k')!;
    assert.equal(k.win.factor, 0.9);
    assert.equal(k.win.streak, 3);
    assert.equal(k.loss.factor, 1);
    const sent = roomStakeFor('k', stakes, placed, 'default', { tournament: false })!;
    assert.equal(sent.win_factor, 0.9);
    assert.equal(sent.win_streak, 3);
    assert.equal(sent.loss_factor, undefined);
});

test('the farmed side: his loss is reduced, his win is full', () => {
    const prev = { atMs: now - 60_000, streak: 2, winnerKey: 'k' };
    const g = matchStakes({ ...base, prev }).get('g')!;
    assert.equal(g.loss.factor, 0.9);
    assert.equal(g.win.factor, 1);
});

test('a full day apart recovers a step', () => {
    const prev = { atMs: now - FARM_RECOVERY_MS - 1, streak: 3, winnerKey: 'k' };
    assert.equal(matchStakes({ ...base, prev }).get('k')!.win.streak, 3);
});

test('tournament: factor 1 both ways and it says so', () => {
    const prev = { atMs: now - 60_000, streak: 6, winnerKey: 'k' };
    const stakes = matchStakes({ ...base, prev, isTournament: true });
    assert.equal(stakes.get('k')!.win.factor, 1);
    const sent = roomStakeFor('k', stakes, placed, 'default', { tournament: true, final: true })!;
    assert.equal(sent.tournament, true);
    assert.equal(sent.final, true);
    assert.equal(sent.win_factor, undefined);
});

test('two new players stake about +242 / −242 at 50 %', () => {
    const fresh = (id: string): SidePlayer => ({ id, rating: 1500, rd: 500, volatility: 0.09 });
    const s = matchStakes({ ...base, sideA: [fresh('a')], sideB: [fresh('b')] }).get('a')!;
    assert.equal(s.winPct, 50);
    assert.ok(Math.abs(s.win.after - s.before - 242) < 2, `${s.win.after - s.before}`);
    assert.ok(Math.abs(s.before - s.loss.after - 242) < 2);
});

test('a spectator, or nothing computed, gets nothing', () => {
    const stakes = matchStakes(base);
    assert.equal(roomStakeFor('watcher', stakes, placed, 'default', { tournament: false }), null);
    assert.equal(roomStakeFor('k', null, placed, 'default', { tournament: false }), null);
});

test('unrounded on the wire', () => {
    const sent = roomStakeFor('k', matchStakes(base), placed, 'default', { tournament: false })!;
    assert.notEqual(sent.win_after, Math.round(sent.win_after!));
});
