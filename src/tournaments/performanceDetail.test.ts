/**
 * Tournament performance in the detail, against SQLite in memory. The REFUSALS are the point: a
 * rival being placed hides the figure (his number would come back through it), a walkover counts
 * for nothing, and nobody gets a figure while his run is still going.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db';
import type { AppContext } from '../context';
import type { BracketMatch } from './bracket';
import { insertTournament } from './store';
import { entrantPerformances } from './performanceDetail';
import { resetRatingPrivacyForTests, setRatingPrivate } from '../elo/ratingPrivacy';

async function setup(rivalGames: number, outcome = 'played') {
    const db = new Db(':memory:');
    db.migrate('migrations');
    const raw = db.raw();
    for (const id of ['owner', 'ana', 'beto']) {
        raw.prepare(`INSERT INTO users (id, discord_id, discord_username, display_name) VALUES (?, ?, ?, ?)`)
            .run(id, `dc-${id}`, id, id === 'ana' ? 'Ana' : id === 'beto' ? 'Beto' : id);
    }
    raw.prepare(`INSERT INTO player_ratings (user_id, mode, rating, rd, games_played) VALUES ('ana', 'default', 1700, 60, 30)`).run();
    raw.prepare(`INSERT INTO player_ratings (user_id, mode, rating, rd, games_played) VALUES ('beto', 'default', 1650, 60, ?)`).run(rivalGames);
    await insertTournament(db, {
        id: 't1', name: 'Cup', modId: 'wol', ownerUserId: 'owner', format: '1v1',
        teamSource: 'solo', entryMode: 'open', capacity: 8,
    });
    for (const [eid, uid] of [['e1', 'ana'], ['e2', 'beto']]) {
        raw.prepare(`INSERT INTO tournament_entrants (id, tournament_id, kind, display_name, captain_user_id, status)
                     VALUES (?, 't1', 'solo', ?, ?, 'confirmed')`).run(eid, uid, uid);
        raw.prepare(`INSERT INTO tournament_entrant_members (entrant_id, user_id) VALUES (?, ?)`).run(eid, uid);
    }
    raw.prepare(`INSERT INTO matches (id, host_user_id, mod_id, mod_combined_hash, map_name, duration_seconds,
                                      started_at, ended_at, rated, rating_mode)
                 VALUES ('m1', 'ana', 'wol', 'h', 'Texas', 900, datetime('now'), datetime('now'), 1, 'default')`).run();
    raw.prepare(`INSERT INTO match_participants (match_id, user_id, result, rating_before, rating_after, rd_before)
                 VALUES ('m1', 'ana', 1, 1690, 1700, 60), ('m1', 'beto', 0, 1660, 1650, 70)`).run();
    raw.prepare(`INSERT INTO tournament_matches (id, tournament_id, round, position, entrant1_id, entrant2_id,
                                                 winner_entrant_id, status, outcome, match_id)
                 VALUES ('s1', 't1', 1, 0, 'e1', 'e2', 'e1', 'done', ?, ?)`)
        .run(outcome, outcome === 'played' ? 'm1' : null);
    const bracket: BracketMatch[] = [{
        id: 's1', round: 1, position: 0, entrant1Id: 'e1', entrant2Id: 'e2', winnerEntrantId: 'e1',
        status: 'done', outcome: outcome as BracketMatch['outcome'], nextMatchId: null, nextSlot: null,
    }];
    const entrants = [
        { id: 'e1', display_name: 'ana', status: 'confirmed' },
        { id: 'e2', display_name: 'beto', status: 'confirmed' },
    ];
    const rosters = new Map([['e1', [{ user_id: 'ana' }]], ['e2', [{ user_id: 'beto' }]]]);
    return { ctx: { db } as unknown as AppContext, bracket, entrants, rosters };
}

test('in a finished tournament the winner gets his best win, the loser none', async () => {
    resetRatingPrivacyForTests();
    const s = await setup(30);
    const perf = await entrantPerformances(s.ctx, { id: 't1', format: '1v1', status: 'finished' }, s.bracket, s.entrants, s.rosters);
    assert.deepEqual((perf.get('e1') as { best_win: unknown }).best_win, { name: 'Beto', rating: 1660 });
    assert.equal((perf.get('e2') as { best_win: unknown }).best_win, null);
});

test('THE ONE THAT MATTERS: a rival being placed hides the figure, for the entrant himself too', async () => {
    resetRatingPrivacyForTests();
    const s = await setup(3);
    const perf = await entrantPerformances(s.ctx, { id: 't1', format: '1v1', status: 'finished' }, s.bracket, s.entrants, s.rosters);
    assert.deepEqual(perf.get('e1'), { hidden: 'placement' });
});

test('a private rival hides it too', async () => {
    resetRatingPrivacyForTests();
    setRatingPrivate('beto', true);
    try {
        const s = await setup(30);
        const perf = await entrantPerformances(s.ctx, { id: 't1', format: '1v1', status: 'finished' }, s.bracket, s.entrants, s.rosters);
        assert.deepEqual(perf.get('e1'), { hidden: 'private' });
    } finally {
        resetRatingPrivacyForTests();
    }
});

test('a walkover counts for nothing', async () => {
    resetRatingPrivacyForTests();
    const s = await setup(30, 'walkover');
    const perf = await entrantPerformances(s.ctx, { id: 't1', format: '1v1', status: 'finished' }, s.bracket, s.entrants, s.rosters);
    assert.equal(perf.size, 0);
});

test('nobody gets one while his run is still going', async () => {
    resetRatingPrivacyForTests();
    const s = await setup(30);
    const perf = await entrantPerformances(s.ctx, { id: 't1', format: '1v1', status: 'running' }, s.bracket, s.entrants, s.rosters);
    assert.equal(perf.has('e1'), false); // the winner is still in
    assert.equal(perf.has('e2'), true);  // the loser is out
});
