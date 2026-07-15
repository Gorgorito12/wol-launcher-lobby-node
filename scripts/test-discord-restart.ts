/**
 * Standalone verification of the "ghost room after a restart" fix.
 * Run: `npx tsx scripts/test-discord-restart.ts`.
 *
 * The bug: discordAnnounce kept its posted message ids in a process-local Map,
 * so a restart orphaned every live announcement — finalizeRoom() missed the Map
 * and returned early, leaving the embed reading "🟢 Open" forever, and nothing
 * ever closed the DB row either.
 *
 * The simulation is honest about what a restart actually destroys: an in-memory
 * SQLite DB that PERSISTS across the "restart" (like the real .db file), while
 * the discordAnnounce module is re-imported under a fresh URL so ESM hands back
 * a brand-new module instance with an empty Map (exactly what a new process
 * gets). A tiny local HTTP server stands in for the Discord webhook and records
 * the POST/PATCH traffic.
 */
import { createServer, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { AddressInfo } from 'node:net';
import { Db } from '../src/db';
import { LobbyRoomRegistry } from '../src/lobbies/LobbyRoom';
import { snapshotOrphanCandidates, sweepOrphanLobbies } from '../src/lobbies/orphanSweep';
import type { AppContext } from '../src/context';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label: string, cond: boolean): void {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
    if (!cond) failures++;
}

const WEBHOOK_ID = '123456789012345678';
const WEBHOOK_TOKEN = 'super-secret-token';
const MESSAGE_ID = 'msg-0001';

interface Hit { method: string; url: string; body: any }

class MockWs extends EventEmitter {
    readyState = 1;
    send(): void { /* frames don't matter here */ }
    close(): void { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
}

/** A stand-in Discord: POST ?wait=true returns a message id; PATCH records the edit. */
function startFakeDiscord(hits: Hit[]): Promise<{ server: Server; base: string }> {
    return new Promise((resolve) => {
        const server = createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', () => {
                hits.push({
                    method: req.method ?? '',
                    url: req.url ?? '',
                    body: raw ? JSON.parse(raw) : null,
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ id: MESSAGE_ID }));
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as AddressInfo;
            resolve({ server, base: `http://127.0.0.1:${port}` });
        });
    });
}

// Tolerate a missing hit: when the fix regresses, no PATCH arrives at all, and
// these must report a clean FAIL rather than crash the run on undefined.
function embedOf(hit: Hit | undefined): any { return hit?.body?.embeds?.[0]; }
function statusFieldOf(hit: Hit | undefined): string {
    return embedOf(hit)?.fields?.find((f: any) => f.name === 'Status')?.value ?? '';
}

async function main(): Promise<void> {
    const hits: Hit[] = [];
    const { server, base } = await startFakeDiscord(hits);
    const webhookUrl = `${base}/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`;

    // This DB survives the "restart", exactly like the real .db file.
    const db = new Db(':memory:');
    db.migrate('migrations');
    const raw = db.raw();
    raw.prepare(
        `INSERT INTO users (id, discord_id, discord_username, display_name, avatar_url)
         VALUES ('U1', 'dc-1', 'Gorgorito12', 'Gorgorito12', 'https://cdn/av.png')`,
    ).run();

    const cfg = { discordWebhookUrls: [webhookUrl], discordPlayersRoleId: '' } as any;
    const log = { warn: () => {}, info: () => {}, error: () => {} } as any;

    // ---------- Process #1: announce a room ----------
    const first = await import('../src/lobbies/discordAnnounce');
    first.configure(cfg, log, db);

    const lobbyId = 'lob00001';
    raw.prepare(
        `INSERT INTO lobbies (id, host_user_id, title, mod_id, mod_combined_hash,
                              max_players, current_players, status)
         VALUES (?, 'U1', 'Wars of Liberty room', 'wol', 'hash', 8, 1, 'open')`,
    ).run(lobbyId);
    raw.prepare(
        `INSERT INTO lobby_members (lobby_id, user_id, role) VALUES (?, 'U1', 'player')`,
    ).run(lobbyId);

    await first.announceLobbyCreated({
        id: lobbyId, title: 'Wars of Liberty room', modId: 'wol',
        maxPlayers: 8, isPrivate: false, hostName: 'Gorgorito12',
        hostAvatar: 'https://cdn/av.png',
    });

    check('create posted one embed to the webhook', hits.filter((h) => h.method === 'POST').length === 1);
    check('posted embed reads Open', statusFieldOf(hits[0]).includes('Open'));

    const persisted = raw.prepare(
        `SELECT discord_targets AS t FROM lobbies WHERE id = ?`,
    ).get(lobbyId) as { t: string | null };
    check('message id persisted to lobbies.discord_targets', !!persisted.t);
    const parsed = JSON.parse(persisted.t ?? '[]');
    check('persisted entry pairs webhook id + message id',
        parsed[0]?.w === WEBHOOK_ID && parsed[0]?.m === MESSAGE_ID);
    check('persisted row does NOT contain the webhook token',
        !(persisted.t ?? '').includes(WEBHOOK_TOKEN));

    // ---------- Simulate the restart ----------
    // A fresh module instance = a fresh (empty) in-memory rooms Map, which is
    // exactly what the new process sees. The DB is untouched.
    const second = await import('../src/lobbies/discordAnnounce.ts?restart=1');
    second.configure(cfg, log, db);

    // ---------- The regression itself ----------
    // Pre-fix this returned early (room missing from the fresh Map) and the
    // embed stayed "Open" forever.
    hits.length = 0;
    second.finalizeRoom(lobbyId);
    await sleep(120);

    const patches = hits.filter((h) => h.method === 'PATCH');
    check('after a restart, finalizeRoom still edits the embed', patches.length === 1);
    check('edit targets the original message id',
        patches[0]?.url.includes(`/messages/${MESSAGE_ID}`));
    check('edited embed reads Closed', statusFieldOf(patches[0]).includes('Closed'));
    check('closed embed drops the Join call-to-action', !embedOf(patches[0])?.description);
    check('closed embed shows a frozen "Lasted", not a live "Opened"',
        embedOf(patches[0])?.fields?.some((f: any) => f.name === 'Lasted'));

    // finalizeRoom only edits Discord; flipping the row is the CALLER's job in
    // every real close path (rest.ts closes the row, then finalizes). Mirror
    // that here so the sweep below only sees the orphan we plant for it.
    raw.prepare(
        `UPDATE lobbies SET status='closed', closed_at=datetime('now') WHERE id = ?`,
    ).run(lobbyId);

    // ---------- The sweep: orphan gets closed ----------
    const kvStore = new Map<string, string>();
    const registry = new LobbyRoomRegistry();
    const ctx = {
        db,
        kv: {
            get: async (k: string) => kvStore.get(k) ?? null,
            put: async (k: string, v: string) => { kvStore.set(k, v); },
            delete: async (k: string) => { kvStore.delete(k); },
        },
        rooms: registry,
        globalChat: { refreshPlayers: () => {} },
        config: cfg,
    } as unknown as AppContext;

    const orphanId = 'lob00002';
    raw.prepare(
        `INSERT INTO lobbies (id, host_user_id, title, mod_id, mod_combined_hash,
                              max_players, current_players, status)
         VALUES (?, 'U1', 'Orphan room', 'wol', 'hash', 8, 1, 'open')`,
    ).run(orphanId);
    raw.prepare(
        `INSERT INTO lobby_members (lobby_id, user_id, role) VALUES (?, 'U1', 'player')`,
    ).run(orphanId);

    // Startup snapshot: the orphan is open right now, so it's a candidate.
    const candidates = await snapshotOrphanCandidates(ctx);
    check('startup snapshot picks up the orphan', candidates.includes(orphanId));

    const closedCount = await sweepOrphanLobbies(ctx, log, candidates);
    check('sweep closes the orphan nobody reconnected to', closedCount === 1);
    const orphanRow = raw.prepare(`SELECT status FROM lobbies WHERE id = ?`).get(orphanId) as { status: string };
    check('orphan row is now closed', orphanRow.status === 'closed');
    const orphanMembers = raw.prepare(
        `SELECT COUNT(*) AS n FROM lobby_members WHERE lobby_id = ?`,
    ).get(orphanId) as { n: number };
    check('orphan lobby_members rows are cleaned up', orphanMembers.n === 0);

    // ---------- The sweep must NOT kill a REVIVED room ----------
    // The launcher auto-reconnects, so a room whose player came back is alive.
    const revivedId = 'lob00003';
    raw.prepare(
        `INSERT INTO lobbies (id, host_user_id, title, mod_id, mod_combined_hash,
                              max_players, current_players, status)
         VALUES (?, 'U1', 'Revived room', 'wol', 'hash', 8, 1, 'open')`,
    ).run(revivedId);
    raw.prepare(
        `INSERT INTO lobby_members (lobby_id, user_id, role) VALUES (?, 'U1', 'player')`,
    ).run(revivedId);

    const revivedCandidates = await snapshotOrphanCandidates(ctx);

    const room = registry.getOrCreate(revivedId, 'U1');
    const ws = new MockWs();
    room.handleConnection(ws as any, ctx);
    const token = 'tok-revived';
    kvStore.set(`lobby:join:${token}`, JSON.stringify({ userId: 'U1', lobbyId: revivedId }));
    ws.emit('message', JSON.stringify({ type: 'hello', join_token: token }));
    await sleep(40);
    check('revived room has a live socket (precondition)', room.socketCount === 1);

    const closed2 = await sweepOrphanLobbies(ctx, log, revivedCandidates);
    const revivedRow = raw.prepare(`SELECT status FROM lobbies WHERE id = ?`).get(revivedId) as { status: string };
    check('sweep leaves a revived room open', revivedRow.status === 'open' && closed2 === 0);

    // ---------- The sweep must NOT touch a room created AFTER startup ----------
    // A room created late in the grace window has its 201 but may not have
    // attached its WS yet — zero sockets, yet very much alive. It isn't in the
    // startup snapshot, so it must survive.
    const freshId = 'lob00004';
    raw.prepare(
        `INSERT INTO lobbies (id, host_user_id, title, mod_id, mod_combined_hash,
                              max_players, current_players, status)
         VALUES (?, 'U1', 'Fresh room', 'wol', 'hash', 8, 1, 'open')`,
    ).run(freshId);
    check('a post-startup room is not a sweep candidate', !revivedCandidates.includes(freshId));

    const closed3 = await sweepOrphanLobbies(ctx, log, revivedCandidates);
    const freshRow = raw.prepare(`SELECT status FROM lobbies WHERE id = ?`).get(freshId) as { status: string };
    check('sweep leaves a room created after startup open',
        freshRow.status === 'open' && closed3 === 0);

    server.close();
    db.close();
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
}

void main();
