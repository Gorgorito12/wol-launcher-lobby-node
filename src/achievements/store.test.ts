/**
 * Achievements against SQLite in memory, built from the migrations. Run: `npm test`.
 *
 * What is pinned here is what the code promises about the TABLE: a medal is written once, never
 * removed by an evaluation (a voided match keeps it), never handed back once revoked, born seen
 * when it predates the feature, and never shown to another player when the rating is private.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db';
import type { AppContext } from '../context';
import {
    awardNew, evaluateAndAward, listEarned, loadEvalInput, markSeen, revoke, resetAchievementsEpochForTests,
} from './store';
import { evaluate, modsOf } from './evaluate';
import { buildPayload } from './payload';
import { AchievementsBatcher, framesFor } from './hooks';
import { GlobalChatRoom } from '../global/GlobalChatRoom';

function freshDb(): Db {
    resetAchievementsEpochForTests();
    const db = new Db(':memory:');
    db.migrate('migrations');
    for (const id of ['me', 'rival', 'third']) {
        db.raw().prepare(
            `INSERT INTO users (id, discord_id, discord_username, display_name) VALUES (?, ?, ?, ?)`,
        ).run(id, `dc-${id}`, id, id);
    }
    return db;
}

let seq = 0;
/** A casual 1v1 of `mod` the player won, `daysAgo` days ago. */
function addMatch(db: Db, p: { mod?: string; result?: number; daysAgo?: number; rival?: string; unrated?: string } = {}): string {
    seq += 1;
    const id = `m${seq}`;
    const lobby = `l${seq}`;
    const raw = db.raw();
    raw.prepare(
        `INSERT INTO lobbies (id, host_user_id, created_by, title, mod_id, mod_combined_hash, max_players, status, roster_at_start)
         VALUES (?, 'me', 'me', 'Room', ?, 'h', 2, 'closed', ?)`,
    ).run(lobby, p.mod ?? 'wol', JSON.stringify(['me', p.rival ?? 'rival']));
    raw.prepare(
        `INSERT INTO matches (id, lobby_id, host_user_id, mod_id, mod_combined_hash, started_at, ended_at,
                              duration_seconds, rated, unrated_reason, created_at, map_name)
         VALUES (?, ?, 'me', ?, 'h', datetime('now'), datetime('now'), 1500, 0, ?,
                 datetime('now', ?), 'amazonia')`,
    ).run(id, lobby, p.mod ?? 'wol', p.unrated ?? 'not_competitive', `-${p.daysAgo ?? 0} days`);
    const result = p.result ?? 1;
    raw.prepare(
        `INSERT INTO match_participants (match_id, user_id, team, civ, result) VALUES (?, 'me', 0, 'British', ?), (?, ?, 0, 'French', ?)`,
    ).run(id, result, id, p.rival ?? 'rival', 1 - result);
    return id;
}

const ctxOf = (db: Db): AppContext => ({ db } as unknown as AppContext);

test('a won match writes its medals once; a second evaluation writes nothing', async () => {
    const db = freshDb();
    addMatch(db);
    const first = await evaluateAndAward(ctxOf(db), 'me');
    const ids = first.awarded.map((a) => a.id).sort();
    assert.deepEqual(ids, ['baptism_of_fire', 'first_blood']);
    assert.ok(first.awarded.every((a) => !a.seen), 'a medal earned after the deploy waits to be shown');
    const second = await evaluateAndAward(ctxOf(db), 'me');
    assert.equal(second.awarded.length, 0);
});

test('THE_ONE_THAT_MATTERS: a medal survives the match being voided', async () => {
    const db = freshDb();
    const id = addMatch(db);
    await evaluateAndAward(ctxOf(db), 'me');
    db.raw().prepare(`UPDATE matches SET unrated_reason = 'voided_by_operator' WHERE id = ?`).run(id);
    db.raw().prepare(`UPDATE match_participants SET result = 0.5 WHERE match_id = ?`).run(id);
    await evaluateAndAward(ctxOf(db), 'me');
    const left = (await listEarned(db, 'me')).map((r) => r.achievement_id).sort();
    assert.deepEqual(left, ['baptism_of_fire', 'first_blood']);
});

test('a revoked medal is not given back', async () => {
    const db = freshDb();
    addMatch(db);
    await evaluateAndAward(ctxOf(db), 'me');
    assert.equal(await revoke(db, 'me', 'wol', 'first_blood', 0), 1);
    const again = await evaluateAndAward(ctxOf(db), 'me');
    assert.equal(again.awarded.length, 0);
    assert.ok(!(await listEarned(db, 'me')).some((r) => r.achievement_id === 'first_blood'));
});

test('medals for matches before the feature are born seen', async () => {
    const db = freshDb();
    addMatch(db, { daysAgo: 30 });
    const r = await evaluateAndAward(ctxOf(db), 'me');
    assert.ok(r.awarded.length > 0 && r.awarded.every((a) => a.seen));
});

test('the backfill writes everything as seen', async () => {
    const db = freshDb();
    addMatch(db);
    const input = await loadEvalInput(db, 'me', Date.now());
    const written = await awardNew(db, 'me', evaluate(input), { bornSeen: true });
    assert.ok(written.length > 0 && written.every((a) => a.seen));
});

test('marking seen touches only the caller, and only what he names', async () => {
    const db = freshDb();
    addMatch(db);
    addMatch(db, { rival: 'third' });
    await evaluateAndAward(ctxOf(db), 'me');
    await markSeen(db, 'rival');
    assert.ok((await listEarned(db, 'me')).every((r) => r.seen_at === null));
    await markSeen(db, 'me', [{ mod: 'WoL', id: 'first_blood', tier: 0 }]);
    const rows = await listEarned(db, 'me');
    assert.ok(rows.find((r) => r.achievement_id === 'first_blood')!.seen_at !== null);
    assert.ok(rows.find((r) => r.achievement_id === 'baptism_of_fire')!.seen_at === null);
});

test("a game's wins never count for another game", async () => {
    const db = freshDb();
    addMatch(db, { mod: 'wol' });
    await evaluateAndAward(ctxOf(db), 'me');
    assert.ok((await listEarned(db, 'me')).every((r) => r.mod_key === 'wol'));
});

test('a report naming another mod than its room is credited to the room', async () => {
    const db = freshDb();
    const id = addMatch(db, { mod: 'aoe3-tad' });
    db.raw().prepare(`UPDATE matches SET mod_id = 'WOL' WHERE id = ?`).run(id);
    await evaluateAndAward(ctxOf(db), 'me');
    assert.ok((await listEarned(db, 'me')).every((r) => r.mod_key === 'aoe3-tad'));
});

test('deleting a match a medal points at does not throw', async () => {
    const db = freshDb();
    const id = addMatch(db);
    await evaluateAndAward(ctxOf(db), 'me');
    db.raw().prepare(`DELETE FROM match_participants WHERE match_id = ?`).run(id);
    db.raw().prepare(`DELETE FROM matches WHERE id = ?`).run(id);
    assert.equal((await listEarned(db, 'me')).length, 2);
});

test('a private rating hides every medal from others, and nothing from him', async () => {
    const db = freshDb();
    addMatch(db);
    await evaluateAndAward(ctxOf(db), 'me');
    const input = await loadEvalInput(db, 'me', Date.now());
    const progress = evaluate(input);
    const earned = await listEarned(db, 'me');
    const other = buildPayload({ modKey: 'wol', mods: modsOf(input), progress: progress.get('wol'), earned, self: false, ratingPrivate: true });
    assert.deepEqual(Object.keys(other).sort(), ['hidden', 'mod', 'total']);
    const own = buildPayload({ modKey: 'wol', mods: modsOf(input), progress: progress.get('wol'), earned, self: true, ratingPrivate: true });
    assert.equal(own.earned, 2);
    assert.equal(own.total, 40);
    assert.equal(own.unseen!.length, 2);
});

test('to others: no unseen, and no rating number on the ELO medals', () => {
    const progress = new Map([['contender', {
        def: { id: 'contender', icon: 'climb', metal: 'b' as const, name: 'Contender', condition: '', rule: { kind: 'elo' as const, ladder: 'default' as const, goal: 1600 } },
        earned: [], value: 1584, goal: 1600,
    }]]);
    const other = buildPayload({ modKey: 'wol', mods: ['wol'], progress, earned: [], self: false, ratingPrivate: false });
    const item = other.groups!.flatMap((g) => g.items).find((i) => i.id === 'contender')!;
    assert.equal(item.value, undefined);
    assert.equal(item.goal, 1600);
    assert.equal(other.unseen, undefined);
    const own = buildPayload({ modKey: 'wol', mods: ['wol'], progress, earned: [], self: true, ratingPrivate: false });
    assert.equal(own.groups!.flatMap((g) => g.items).find((i) => i.id === 'contender')!.value, 1584);
});

test('only unseen medals become a frame, one per game', () => {
    const frames = framesFor([
        { modKey: 'wol', id: 'first_blood', tier: 0, earnedAt: '2026-11-21 10:00:00', seen: false },
        { modKey: 'wol', id: 'veteran', tier: 0, earnedAt: '2026-11-21 10:00:00', seen: true },
        { modKey: 'aoe3-tad', id: 'mirror', tier: 0, earnedAt: '2026-11-21 10:00:00', seen: false },
    ], new Map([['wol', 7]]));
    assert.equal(frames.length, 2);
    const wol = frames.find((f) => f.mod === 'wol')!;
    assert.deepEqual(wol.items.map((i) => i.id), ['first_blood']);
    assert.equal(wol.earned, 7);
    assert.equal(wol.total, 40);
    assert.equal(wol.items[0]!.earned_at, '2026-11-21T10:00:00Z');
});

test('a burst of notes is one evaluation', async () => {
    const runs: string[][] = [];
    const scheduled: Array<() => void> = [];
    const b = new AchievementsBatcher(async (ids) => { runs.push(ids); }, 1000, (fn) => { scheduled.push(fn); });
    b.add(['me', 'rival']);
    b.add(['me', 'third']);
    assert.equal(scheduled.length, 1);
    scheduled[0]!();
    await b.flush();
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0]!.sort(), ['me', 'rival', 'third']);
});

test('an older launcher (no "achievements" in its hello) never receives the frame', () => {
    const room = new GlobalChatRoom();
    const sent: string[] = [];
    const sock = (features: string[]) => ({ readyState: 1, send: (p: string) => sent.push(p), features });
    const attached = (room as unknown as { attached: Map<unknown, unknown> }).attached;
    attached.set(sock([]), { userId: 'old', features: new Set<string>() });
    attached.set(sock(['achievements']), { userId: 'new', features: new Set(['achievements']) });
    assert.equal(room.sendToFeature('old', 'achievements', { type: 'achievement_unlocked' }), false);
    assert.equal(room.sendToFeature('new', 'achievements', { type: 'achievement_unlocked' }), true);
    assert.equal(sent.length, 1);
});
