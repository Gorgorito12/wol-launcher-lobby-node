/**
 * GET /lobbies/:id/live (src/lobbies/live.ts), against SQLite in memory built from the
 * migrations. Run: `npm test`. The REFUSALS are the point: a private tournament's room must be
 * indistinguishable from a missing id to a stranger, and the body must never carry chat, a
 * password hash, a Radmin address, an in-game name, or the number of a player being placed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db';
import { insertTournament } from '../tournaments/store';
import { buildLive, loadLiveLobby, mayWatch, stillVisible, CLOSED_VISIBLE_MS } from './live';
import { resetRatingPrivacyForTests, setRatingPrivate } from '../elo/ratingPrivacy';

function freshDb(): Db {
    const db = new Db(':memory:');
    db.migrate('migrations');
    const raw = db.raw();
    for (const id of ['owner', 'helper', 'player', 'rival', 'stranger', 'newbie']) {
        raw.prepare(`INSERT INTO users (id, discord_id, discord_username, display_name) VALUES (?, ?, ?, ?)`)
            .run(id, `dc-${id}`, id, id);
    }
    raw.prepare(`INSERT INTO player_ratings (user_id, mode, rating, rd, games_played) VALUES ('player', 'default', 1612.4, 60, 40)`).run();
    raw.prepare(`INSERT INTO player_ratings (user_id, mode, rating, rd, games_played) VALUES ('newbie', 'default', 1490, 300, 3)`).run();
    return db;
}

function lobby(db: Db, id: string, status = 'in_game', matchId: string | null = null, closedAgo = 0): void {
    db.raw().prepare(
        `INSERT INTO lobbies (id, host_user_id, title, mod_id, mod_combined_hash, max_players, status, password_hash,
                              started_at, closed_at, tournament_match_id, competitive)
         VALUES (?, 'player', 'Room', 'wol', 'h', 2, ?, 'secret-hash', datetime('now', '-5 minutes'),
                 CASE WHEN ? = 'closed' THEN datetime('now', ?) END, ?, 1)`,
    ).run(id, status, status, `-${closedAgo} seconds`, matchId);
    for (const u of ['player', 'newbie']) {
        db.raw().prepare(`INSERT INTO lobby_members (lobby_id, user_id, role) VALUES (?, ?, 'player')`).run(id, u);
    }
}

async function privateTournamentRoom(db: Db): Promise<void> {
    await insertTournament(db, {
        id: 't1', name: 'Private', modId: 'wol', ownerUserId: 'owner', format: '1v1',
        teamSource: 'solo', entryMode: 'open', capacity: 8, visibility: 'private', inviteCode: 'K7N9P2XA',
    });
    const raw = db.raw();
    raw.prepare(`INSERT INTO tournament_managers (tournament_id, user_id, added_by) VALUES ('t1', 'helper', 'owner')`).run();
    raw.prepare(`INSERT INTO tournament_entrants (id, tournament_id, kind, display_name, captain_user_id, status)
                 VALUES ('e1', 't1', 'solo', 'player', 'player', 'confirmed')`).run();
    raw.prepare(`INSERT INTO tournament_entrant_members (entrant_id, user_id) VALUES ('e1', 'player')`).run();
    raw.prepare(`INSERT INTO tournament_matches (id, tournament_id, round, position, entrant1_id, status)
                 VALUES ('s1', 't1', 1, 0, 'e1', 'pending')`).run();
    lobby(db, 'priv', 'in_game', 's1');
}

test('THE ONE THAT MATTERS: a private tournament room is a missing id to a stranger', async () => {
    const db = freshDb();
    await privateTournamentRoom(db);
    const now = Date.now();
    const row = await loadLiveLobby(db, 'priv');
    const missing = await mayWatch(db, await loadLiveLobby(db, 'nope'), 'stranger', undefined, now);
    assert.equal(missing.ok, false);
    for (const who of ['stranger', undefined]) {
        assert.equal((await mayWatch(db, row, who, undefined, now)).ok, false, String(who));
    }
    assert.equal((await mayWatch(db, row, 'stranger', 'WRONGCODE', now)).ok, false);
    for (const who of ['owner', 'helper', 'player']) {
        assert.equal((await mayWatch(db, row, who, undefined, now)).ok, true, who);
    }
    assert.equal((await mayWatch(db, row, 'stranger', 'K7N9P2XA', now)).ok, true);
});

test('the body carries no chat, password, address or in-game name, and no number for a player being placed', async () => {
    resetRatingPrivacyForTests();
    const db = freshDb();
    lobby(db, 'open1');
    const body = await buildLive(db, (await loadLiveLobby(db, 'open1'))!);
    const text = JSON.stringify(body).toLowerCase();
    for (const banned of ['secret-hash', 'password', 'chat', 'radmin', 'ingame', 'in_game_name']) {
        assert.equal(text.includes(banned), false, banned);
    }
    const placed = body.members.find((m) => m.id === 'player')!;
    const placing = body.members.find((m) => m.id === 'newbie')!;
    assert.equal(placed.rating, 1612);
    assert.equal('rating' in placing, false);
    assert.equal(body.phase, 'playing');
});

test('a player who keeps his rating private has no number in it', async () => {
    resetRatingPrivacyForTests();
    setRatingPrivate('player', true);
    try {
        const db = freshDb();
        lobby(db, 'open2');
        const body = await buildLive(db, (await loadLiveLobby(db, 'open2'))!);
        assert.equal('rating' in body.members.find((m) => m.id === 'player')!, false);
    } finally {
        resetRatingPrivacyForTests();
    }
});

test('a closed room shows its result for 24 hours, then is gone', async () => {
    const db = freshDb();
    lobby(db, 'done', 'closed', null, 60);
    db.raw().prepare(`INSERT INTO matches (id, lobby_id, host_user_id, mod_id, mod_combined_hash, started_at, ended_at, duration_seconds, rated)
                      VALUES ('m1', 'done', 'player', 'wol', 'h', datetime('now'), datetime('now'), 600, 1)`).run();
    db.raw().prepare(`INSERT INTO match_participants (match_id, user_id, team, civ, result, rating_before, rating_after)
                      VALUES ('m1', 'player', 1, 'British', 1.0, 1600, 1612), ('m1', 'newbie', 2, 'French', 0.0, 1490, 1478)`).run();
    const row = (await loadLiveLobby(db, 'done'))!;
    const body = await buildLive(db, row);
    assert.equal(body.phase, 'ended');
    assert.deepEqual(body.members, []);
    assert.equal(body.result?.players.find((p) => p.id === 'player')?.civ, 'British');
    assert.equal(JSON.stringify(body.result).includes('rating'), false);
    assert.equal(stillVisible(row, Date.now()), true);
    assert.equal(stillVisible(row, Date.now() + CLOSED_VISIBLE_MS + 120_000), false);
});
