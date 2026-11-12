/**
 * Who sees an ended tournament, who may delete one, and what the startup sweep deletes
 * (2026-11-11). Run: `npm test`.
 *
 * Unlike `listing.test.ts`, which pins SQL text, this runs the real queries against a real
 * SQLite database in memory, built from the migrations - the same rig the scripts in
 * `scripts/test-*.ts` use. The refusals are the point: a tournament with a game played is
 * never deleted, by the owner or by the sweep, and a stranger never sees somebody else's
 * cancelled draft.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db';
import {
    deleteDue, deleteTournament, hasGames, listMine, listOwnDrafts, listTournaments,
} from './store';
import { isPubliclyListed, mayDelete, type TournamentStatus } from './lifecycle';

const DAY = 24 * 60 * 60 * 1000;

function freshDb(): Db {
    const db = new Db(':memory:');
    db.migrate('migrations');
    const raw = db.raw();
    for (const id of ['owner', 'player', 'stranger']) {
        raw.prepare(
            `INSERT INTO users (id, discord_id, discord_username, display_name, avatar_url)
             VALUES (?, ?, ?, ?, ?)`,
        ).run(id, `dc-${id}`, id, id, `https://cdn.example/${id}.png`);
    }
    return db;
}

/** A tournament `daysAgo` old in every timestamp, with an entrant for 'player' and one slot. */
function insert(db: Db, id: string, status: TournamentStatus, daysAgo: number, played = false): void {
    const raw = db.raw();
    const at = `datetime('now', '-${daysAgo} days')`;
    raw.prepare(
        `INSERT INTO tournaments (id, name, mod_id, owner_user_id, status, created_at, last_activity_at,
                                  cancelled_at, abandoned_at, finished_at)
         VALUES (?, ?, 'wol', 'owner', ?, ${at}, ${at},
                 ${status === 'cancelled' ? at : 'NULL'}, ${status === 'abandoned' ? at : 'NULL'},
                 ${status === 'finished' ? at : 'NULL'})`,
    ).run(id, `T ${id}`, status);
    raw.prepare(
        `INSERT INTO tournament_entrants (id, tournament_id, kind, display_name, captain_user_id, status)
         VALUES (?, ?, 'solo', 'player', 'player', 'confirmed')`,
    ).run(`e-${id}`, id);
    raw.prepare(`INSERT INTO tournament_entrant_members (entrant_id, user_id) VALUES (?, 'player')`)
        .run(`e-${id}`);
    let matchId: string | null = null;
    if (played) {
        matchId = `m-${id}`;
        raw.prepare(
            `INSERT INTO matches (id, host_user_id, mod_id, mod_combined_hash, started_at, ended_at)
             VALUES (?, 'owner', 'wol', 'h', datetime('now'), datetime('now'))`,
        ).run(matchId);
    }
    raw.prepare(
        `INSERT INTO tournament_matches (id, tournament_id, round, position, entrant1_id, status, match_id)
         VALUES (?, ?, 1, 0, ?, ?, ?)`,
    ).run(`s-${id}`, id, `e-${id}`, played ? 'done' : 'pending', matchId);
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

test('THE ONE THAT MATTERS: a tournament with a game played is never deleted', async () => {
    const db = freshDb();
    insert(db, 'played', 'cancelled', 30, true);
    insert(db, 'playedAbandoned', 'abandoned', 30, true);
    assert.equal(await hasGames(db, 'played'), true);
    assert.equal(await deleteTournament(db, 'played'), false);
    assert.deepEqual(await deleteDue(db), []);
    const left = db.raw().prepare(`SELECT COUNT(*) AS n FROM tournaments`).get() as { n: number };
    assert.equal(left.n, 2);
});

test('a game reported from a room counts as played even if it moved nothing', async () => {
    const db = freshDb();
    insert(db, 'pending', 'cancelled', 1);
    db.raw().prepare(
        `INSERT INTO matches (id, host_user_id, mod_id, mod_combined_hash, started_at, ended_at, tournament_match_id)
         VALUES ('m-r', 'owner', 'wol', 'h', datetime('now'), datetime('now'), 's-pending')`,
    ).run();
    assert.equal(await hasGames(db, 'pending'), true);
    assert.equal(await deleteTournament(db, 'pending'), false);
});

test('the public list follows the table', async () => {
    const db = freshDb();
    insert(db, 'live', 'registration', 1);
    insert(db, 'draft', 'draft', 1);
    insert(db, 'cancelledEmpty', 'cancelled', 2);
    insert(db, 'cancelledPlayed', 'cancelled', 2, true);
    insert(db, 'cancelledOld', 'cancelled', 10, true);
    insert(db, 'finishedNew', 'finished', 5, true);
    insert(db, 'finishedOld', 'finished', 40, true);
    assert.deepEqual(ids(await listTournaments(db, 50)), ['cancelledPlayed', 'finishedNew', 'live']);
});

test('the owner sees their cancelled one without games; nobody else does', async () => {
    const db = freshDb();
    insert(db, 'cancelledEmpty', 'cancelled', 2);
    insert(db, 'draft', 'draft', 1);
    assert.deepEqual(ids(await listMine(db, 'owner')), ['cancelledEmpty']);
    assert.deepEqual(ids(await listMine(db, 'stranger')), []);
    assert.deepEqual(ids(await listMine(db, 'player')), []);
    assert.deepEqual(ids(await listOwnDrafts(db, 'owner')), ['draft']);
    assert.deepEqual(ids(await listOwnDrafts(db, 'stranger')), []);
});

test('an old finished tournament stays with who took part', async () => {
    const db = freshDb();
    insert(db, 'finishedOld', 'finished', 40, true);
    assert.deepEqual(ids(await listMine(db, 'player')), ['finishedOld']);
    assert.deepEqual(ids(await listMine(db, 'owner')), ['finishedOld']);
    assert.deepEqual(ids(await listMine(db, 'stranger')), []);
});

test('deleting takes the entrants, rosters and bracket with it', async () => {
    const db = freshDb();
    insert(db, 'gone', 'cancelled', 1);
    db.raw().prepare(
        `INSERT INTO lobbies (id, host_user_id, title, mod_id, mod_combined_hash, max_players,
                              current_players, status, tournament_match_id)
         VALUES ('lob', 'owner', 'x', 'wol', 'h', 2, 0, 'closed', 's-gone')`,
    ).run();
    assert.equal(await deleteTournament(db, 'gone'), true);
    const raw = db.raw();
    for (const table of ['tournaments', 'tournament_entrants', 'tournament_entrant_members', 'tournament_matches']) {
        const n = (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        assert.equal(n, 0, `${table} should be empty`);
    }
    const lobby = raw.prepare(`SELECT tournament_match_id FROM lobbies WHERE id = 'lob'`).get() as
        { tournament_match_id: string | null };
    assert.equal(lobby.tournament_match_id, null);
});

test('a live tournament is never deleted by the owner', async () => {
    const db = freshDb();
    insert(db, 'running', 'running', 1);
    assert.equal(await deleteTournament(db, 'running'), false);
    assert.equal(mayDelete({ status: 'running', played: false }), false);
    assert.equal(mayDelete({ status: 'cancelled', played: true }), false);
    assert.equal(mayDelete({ status: 'abandoned', played: false }), true);
});

test('the sweep deletes a stale draft and an unplayed ended week, nothing else', async () => {
    const db = freshDb();
    insert(db, 'draftOld', 'draft', 9);
    insert(db, 'draftNew', 'draft', 2);
    insert(db, 'abandonedOld', 'abandoned', 9);
    insert(db, 'cancelledNew', 'cancelled', 2);
    insert(db, 'cancelledOldPlayed', 'cancelled', 9, true);
    insert(db, 'finishedOld', 'finished', 90, true);
    assert.deepEqual((await deleteDue(db)).sort(), ['abandonedOld', 'draftOld']);
});

test('the JS twin agrees with the SQL for every row', async () => {
    const db = freshDb();
    const rows: [string, TournamentStatus, number, boolean][] = [
        ['a', 'registration', 1, false], ['b', 'draft', 1, false], ['c', 'cancelled', 2, false],
        ['d', 'cancelled', 2, true], ['e', 'cancelled', 10, true], ['f', 'finished', 5, true],
        ['g', 'finished', 40, true], ['h', 'abandoned', 3, true], ['i', 'running', 40, false],
    ];
    for (const [id, status, days, played] of rows) insert(db, id, status, days, played);
    const listed = new Set((await listTournaments(db, 50)).map((r) => r.id));
    const now = Date.now();
    for (const [id, status, days, played] of rows) {
        const stamp = new Date(now - days * DAY).toISOString().replace('T', ' ').slice(0, 19);
        const twin = isPubliclyListed({
            status, createdAt: stamp, lastActivityAt: stamp, played,
            endedAt: status === 'cancelled' || status === 'abandoned' ? stamp : null,
            finishedAt: status === 'finished' ? stamp : null,
        }, now);
        assert.equal(twin, listed.has(id), `${id} (${status}, ${days} days, played=${played})`);
    }
});

test('the CLI --force path deletes a played tournament and leaves its game alone', async () => {
    const db = freshDb();
    insert(db, 'forced', 'running', 1, true);
    db.raw().prepare(`UPDATE matches SET tournament_match_id = 's-forced' WHERE id = 'm-forced'`).run();
    await db.prepare(`DELETE FROM tournaments WHERE id = ?`).bind('forced').run();
    const raw = db.raw();
    const game = raw.prepare(`SELECT tournament_match_id FROM matches WHERE id = 'm-forced'`).get() as
        { tournament_match_id: string | null } | undefined;
    // The game stays, still marked as a tournament game so the anti-farm rule keeps skipping it.
    assert.equal(game?.tournament_match_id, 's-forced');
    assert.equal((raw.prepare(`SELECT COUNT(*) AS n FROM tournament_matches`).get() as { n: number }).n, 0);
});
