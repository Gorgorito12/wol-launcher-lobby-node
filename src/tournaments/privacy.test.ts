/**
 * Private tournaments (2026-11-13). Run: `npm test`.
 *
 * A private tournament is never in the public list, its detail and its entry answer 404 to a
 * stranger, its rooms are not in GET /lobbies and its name is not in any public match list. Its
 * owner, co-organisers and entrants see it in `mine`, in every state, finished included; somebody
 * else reaches it only with its invite code.
 *
 * Runs the real queries against SQLite in memory, built from the migrations, like
 * cleanup.test.ts. Nearly every case is a REFUSAL, because the failure that matters is a private
 * tournament reaching somebody it should not, and that failure throws nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db';
import {
    getByInviteCode, insertTournament, isMemberOf, listMine, listTournaments, maySee,
    getTournament,
} from './store';
import { LOBBY_LIST_SQL } from '../lobbies/rest';
import { TOURNAMENT_REF_COLUMNS, TOURNAMENT_REF_JOIN, withTournamentRef } from './matchRef';
import { readCode } from './inviteCode';
import { isPubliclyListed } from './lifecycle';

const CODE = 'K7N9P2XA';
let codeCounter = 0;

function freshDb(): Db {
    const db = new Db(':memory:');
    db.migrate('migrations');
    const raw = db.raw();
    for (const id of ['owner', 'helper', 'player', 'stranger']) {
        raw.prepare(
            `INSERT INTO users (id, discord_id, discord_username, display_name) VALUES (?, ?, ?, ?)`,
        ).run(id, `dc-${id}`, id, id);
    }
    return db;
}

/** A private (or public) tournament in `status`, with 'player' entered and 'helper' co-organising. */
async function insert(
    db: Db, id: string, status: string, visibility: 'public' | 'private', played = false,
): Promise<void> {
    await insertTournament(db, {
        id, name: `T ${id}`, modId: 'wol', ownerUserId: 'owner', format: '1v1',
        teamSource: 'solo', entryMode: 'open', capacity: 8, visibility,
        inviteCode: visibility === 'private' ? `${CODE.slice(0, 7)}${codeCounter++}` : null,
    });
    const raw = db.raw();
    raw.prepare(
        `UPDATE tournaments SET status = ?, finished_at = CASE WHEN ? = 'finished'
             THEN datetime('now', '-400 days') END,
             last_activity_at = datetime('now', '-1 days') WHERE id = ?`,
    ).run(status, status, id);
    raw.prepare(`INSERT INTO tournament_managers (tournament_id, user_id, added_by) VALUES (?, 'helper', 'owner')`).run(id);
    raw.prepare(
        `INSERT INTO tournament_entrants (id, tournament_id, kind, display_name, captain_user_id, status)
         VALUES (?, ?, 'solo', 'player', 'player', 'confirmed')`,
    ).run(`e-${id}`, id);
    raw.prepare(`INSERT INTO tournament_entrant_members (entrant_id, user_id) VALUES (?, 'player')`)
        .run(`e-${id}`);
    raw.prepare(
        `INSERT INTO tournament_matches (id, tournament_id, round, position, entrant1_id, status)
         VALUES (?, ?, 1, 0, ?, 'pending')`,
    ).run(`s-${id}`, id, `e-${id}`);
    if (played) {
        raw.prepare(
            `INSERT INTO matches (id, host_user_id, mod_id, mod_combined_hash, started_at, ended_at,
                                  tournament_match_id)
             VALUES (?, 'owner', 'wol', 'h', datetime('now'), datetime('now'), ?)`,
        ).run(`m-${id}`, `s-${id}`);
    }
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

test('THE ONE THAT MATTERS: a private tournament is never in the public list, in any state', async () => {
    const db = freshDb();
    for (const s of ['registration', 'running', 'finished']) await insert(db, `p${s}`, s, 'private', s === 'finished');
    await insert(db, 'pub', 'registration', 'public');
    assert.deepEqual(ids(await listTournaments(db, 50)), ['pub']);
});

test('its owner, co-organiser and entrant see it in "mine"; a stranger never does', async () => {
    const db = freshDb();
    await insert(db, 'live', 'registration', 'private');
    await insert(db, 'done', 'finished', 'private', true);
    for (const who of ['owner', 'helper', 'player']) {
        assert.deepEqual(ids(await listMine(db, who)), ['done', 'live'], who);
    }
    assert.deepEqual(ids(await listMine(db, 'stranger')), []);
});

test('somebody who withdrew or was rejected stops seeing it', async () => {
    const db = freshDb();
    await insert(db, 'live', 'registration', 'private');
    db.raw().prepare(`UPDATE tournament_entrants SET status = 'withdrawn' WHERE id = 'e-live'`).run();
    assert.deepEqual(ids(await listMine(db, 'player')), []);
    assert.equal(await isMemberOf(db, 'live', 'player'), false);
});

test('the detail answers a stranger only with the right code', async () => {
    const db = freshDb();
    await insert(db, 'live', 'registration', 'private');
    const t = (await getTournament(db, 'live'))!;
    assert.equal(t.visibility, 'private');
    assert.ok(t.invite_code);
    assert.equal(await maySee(db, t, 'stranger', undefined), false);
    assert.equal(await maySee(db, t, undefined, undefined), false);
    assert.equal(await maySee(db, t, 'stranger', 'ZZZZZZZZ'), false);
    assert.equal(await maySee(db, t, 'stranger', t.invite_code!), true);
    assert.equal(await maySee(db, t, 'player', undefined), true);
    assert.equal(await maySee(db, t, 'helper', undefined), true);
});

test('a public tournament is seen by anybody, with or without a code', async () => {
    const db = freshDb();
    await insert(db, 'pub', 'registration', 'public');
    const t = (await getTournament(db, 'pub'))!;
    assert.equal(t.invite_code, null);
    assert.equal(await maySee(db, t, undefined, undefined), true);
});

test('a code opens only a private tournament, and only its own', async () => {
    const db = freshDb();
    await insert(db, 'aa', 'registration', 'private');
    await insert(db, 'bb', 'registration', 'private');
    const a = (await getTournament(db, 'aa'))!;
    assert.equal((await getByInviteCode(db, a.invite_code!))?.id, 'aa');
    assert.equal(await getByInviteCode(db, 'ZZZZZZZZ'), undefined);
});

test('a typed code is read leniently and anything else is no code at all', () => {
    assert.equal(readCode(' k7n9p2xa '), 'K7N9P2XA');
    assert.equal(readCode('K7N9P2X'), undefined);       // too short
    assert.equal(readCode('K7N9P2XAB'), undefined);     // too long
    assert.equal(readCode('K7N9P2XI'), undefined);      // I is not in the alphabet
    assert.equal(readCode("K7N9'--A"), undefined);
    assert.equal(readCode(12345678), undefined);
});

test('the room of a private match is not in the rooms list; a public one is', async () => {
    const db = freshDb();
    await insert(db, 'priv', 'running', 'private');
    await insert(db, 'pub', 'running', 'public');
    const raw = db.raw();
    for (const [lob, slot] of [['L1', 's-priv'], ['L2', 's-pub']] as const) {
        raw.prepare(
            `INSERT INTO lobbies (id, host_user_id, title, mod_id, mod_combined_hash, max_players,
                                  current_players, status, tournament_match_id)
             VALUES (?, 'player', 'x', 'wol', 'h', 2, 1, 'open', ?)`,
        ).run(lob, slot);
    }
    const rows = raw.prepare(LOBBY_LIST_SQL).all() as { id: string }[];
    assert.deepEqual(rows.map((r) => r.id).sort(), ['L2']);
});

test('a game of a private bracket names no tournament in a public match list', async () => {
    const db = freshDb();
    await insert(db, 'priv', 'finished', 'private', true);
    await insert(db, 'pub', 'finished', 'public', true);
    const rows = db.raw().prepare(
        `SELECT m.id, ${TOURNAMENT_REF_COLUMNS} FROM matches m ${TOURNAMENT_REF_JOIN} ORDER BY m.id`,
    ).all() as Record<string, unknown>[];
    const byId = new Map(rows.map((r) => [r.id as string, withTournamentRef(r)]));
    assert.equal(byId.get('m-priv')?.tournament, null);
    assert.equal(byId.get('m-pub')?.tournament?.name, 'T pub');
});

test('the JS twin never lists a private one either', () => {
    const at = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const base = { createdAt: at, lastActivityAt: at, endedAt: null, finishedAt: at, played: true };
    assert.equal(isPubliclyListed({ ...base, status: 'finished', visibility: 'private' }, Date.now()), false);
    assert.equal(isPubliclyListed({ ...base, status: 'finished' }, Date.now()), true);
});
