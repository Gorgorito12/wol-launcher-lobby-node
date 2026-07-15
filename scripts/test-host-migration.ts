/**
 * Standalone verification of host migration + the abrupt-close DB bookkeeping
 * (the ghost-host path). Run: `npx tsx scripts/test-host-migration.ts`.
 *
 * No HTTP/auth stack: an in-memory SQLite DB + a mock kv + mock WebSockets
 * (EventEmitters) driven straight through LobbyRoom. The key case is closing a
 * socket WITHOUT REST /leave — the path that exposes the ghost-host bug.
 */
import { EventEmitter } from 'node:events';
import { LobbyRoomRegistry } from '../src/lobbies/LobbyRoom';
import { Db } from '../src/db';
import type { AppContext } from '../src/context';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label: string, cond: boolean): void {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
    if (!cond) failures++;
}

class MockWs extends EventEmitter {
    readyState = 1; // OPEN
    sent: any[] = [];
    send(data: string): void { this.sent.push(JSON.parse(data)); }
    close(): void { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
    framesOfType(t: string): any[] { return this.sent.filter((f) => f.type === t); }
}

function lastHostChanged(ws: MockWs): string | undefined {
    const fs = ws.framesOfType('host_changed');
    return fs.length ? fs[fs.length - 1].new_host_user_id : undefined;
}

async function main(): Promise<void> {
    const db = new Db(':memory:');
    db.migrate('migrations');

    // Seed 3 users + a lobby hosted by A + 3 members in join order A<B<C.
    const lobbyId = 'lob12345';
    const raw = db.raw();
    for (const [id, joined] of [['A', '01'], ['B', '02'], ['C', '03']] as const) {
        raw.prepare(
            `INSERT INTO users (id, discord_id, discord_username, display_name) VALUES (?, ?, ?, ?)`,
        ).run(id, `dc-${id}`, `User${id}`, `User${id}`);
        if (id === 'A') {
            raw.prepare(
                `INSERT INTO lobbies (id, host_user_id, title, mod_id, mod_combined_hash, current_players, status)
                 VALUES (?, 'A', 'Test', 'wol', 'hash', 3, 'open')`,
            ).run(lobbyId);
        }
        raw.prepare(
            `INSERT INTO lobby_members (lobby_id, user_id, joined_at, role)
             VALUES (?, ?, ?, 'player')`,
        ).run(lobbyId, id, `2026-01-01 00:00:${joined}`);
    }

    const kvStore = new Map<string, string>();
    const ctx = {
        db,
        kv: {
            get: async (k: string) => kvStore.get(k) ?? null,
            put: async (k: string, v: string) => { kvStore.set(k, v); },
            delete: async (k: string) => { kvStore.delete(k); },
        },
        config: { chatMsgsPerMin: 30 },
        // handleDisconnectCleanup nudges the global players panel, so the mock
        // ctx needs it or every abrupt-close case dies on undefined. This script
        // rotted silently when that call was added — it is the pin for host
        // migration, so keep the mock in step with what LobbyRoom touches.
        globalChat: { refreshPlayers: () => {} },
    } as unknown as AppContext;

    const registry = new LobbyRoomRegistry();
    const room = registry.getOrCreate(lobbyId, 'A');

    async function connect(r: any, lid: string, userId: string): Promise<MockWs> {
        const ws = new MockWs();
        r.handleConnection(ws as any, ctx);
        const token = `tok-${lid}-${userId}`;
        kvStore.set(`lobby:join:${token}`, JSON.stringify({ userId, lobbyId: lid }));
        ws.emit('message', JSON.stringify({ type: 'hello', join_token: token }));
        await sleep(30);
        return ws;
    }

    const wsA = await connect(room, lobbyId, 'A');
    const wsB = await connect(room, lobbyId, 'B');
    const wsC = await connect(room, lobbyId, 'C');
    check('A got room_state on hello', wsA.framesOfType('room_state').length === 1);

    const hostOf = async () =>
        (await db.prepare(`SELECT host_user_id FROM lobbies WHERE id = ?`).bind(lobbyId)
            .first<{ host_user_id: string }>())?.host_user_id;
    const countOf = async () =>
        (await db.prepare(`SELECT current_players FROM lobbies WHERE id = ?`).bind(lobbyId)
            .first<{ current_players: number }>())?.current_players;
    const membersLeft = async () =>
        (await db.prepare(`SELECT user_id FROM lobby_members WHERE lobby_id = ? ORDER BY joined_at`)
            .bind(lobbyId).all<{ user_id: string }>()).results.map((r) => r.user_id);

    // --- Abrupt close of host A (NO REST /leave) → B inherits. ---
    wsA.close();
    await sleep(60);
    check('host_changed broadcast names B', lastHostChanged(wsB) === 'B' || lastHostChanged(wsC) === 'B');
    check('DB host_user_id is B', (await hostOf()) === 'B');
    check('current_players is 2', (await countOf()) === 2);
    check('A removed from lobby_members (no ghost)', !(await membersLeft()).includes('A'));
    check('lobby still open', (await db.prepare(`SELECT status FROM lobbies WHERE id=?`).bind(lobbyId)
        .first<{ status: string }>())?.status === 'open');

    // B (now host) can start the game.
    wsB.emit('message', JSON.stringify({ type: 'start' }));
    await sleep(30);
    check('B (new host) can start', wsB.framesOfType('game_countdown').length === 1 || wsC.framesOfType('game_countdown').length === 1);
    check('B start was NOT forbidden', wsB.framesOfType('error').filter((e) => e.code === 'forbidden').length === 0);

    // --- Abrupt close of B → C inherits. ---
    wsB.close();
    await sleep(60);
    check('host migrates to C', (await hostOf()) === 'C');
    check('current_players is 1', (await countOf()) === 1);

    // --- Last member C leaves → lobby closes. ---
    wsC.close();
    await sleep(60);
    check('lobby closed when empty', (await db.prepare(`SELECT status FROM lobbies WHERE id=?`).bind(lobbyId)
        .first<{ status: string }>())?.status === 'closed');

    // ===== Scenario 2: radmin_ip + abort grace window =====
    const lob2 = 'lob2xxxx';
    raw.prepare(
        `INSERT INTO lobbies (id, host_user_id, title, mod_id, mod_combined_hash, current_players, status)
         VALUES (?, 'A', 'Test2', 'wol', 'hash', 2, 'open')`,
    ).run(lob2);
    raw.prepare(`INSERT INTO lobby_members (lobby_id, user_id, joined_at, role) VALUES (?, 'A', '2026-01-02 00:00:01', 'player')`).run(lob2);
    raw.prepare(`INSERT INTO lobby_members (lobby_id, user_id, joined_at, role) VALUES (?, 'B', '2026-01-02 00:00:02', 'player')`).run(lob2);
    const room2: any = registry.getOrCreate(lob2, 'A');
    const a2 = await connect(room2, lob2, 'A');
    const b2 = await connect(room2, lob2, 'B');

    // A reports its Radmin IP → member_net broadcast to B + stored on the member.
    a2.emit('message', JSON.stringify({ type: 'set_radmin_ip', ip: '26.10.20.30' }));
    await sleep(30);
    check('member_net broadcast carries A radmin_ip', b2.framesOfType('member_net').some((f) => f.user_id === 'A' && f.radmin_ip === '26.10.20.30'));
    // A bad (non-26.x) IP is rejected — no extra member_net.
    a2.emit('message', JSON.stringify({ type: 'set_radmin_ip', ip: '8.8.8.8' }));
    await sleep(30);
    check('non-26.x radmin_ip rejected', b2.framesOfType('member_net').filter((f) => f.user_id === 'A').length === 1);
    // A late joiner's room_state carries the stored radmin_ip.
    raw.prepare(`INSERT INTO lobby_members (lobby_id, user_id, joined_at, role) VALUES (?, 'C', '2026-01-02 00:00:03', 'player')`).run(lob2);
    const c2 = await connect(room2, lob2, 'C');
    const rs = c2.framesOfType('room_state')[0];
    check('room_state includes A radmin_ip for late joiner', rs?.members?.A?.radminIp === '26.10.20.30');

    // Start → any member can abort WITHIN the window.
    a2.emit('message', JSON.stringify({ type: 'start' }));
    await sleep(30);
    b2.emit('message', JSON.stringify({ type: 'cancel_game', reason: 'desync' }));
    await sleep(30);
    check('non-host can abort within window', b2.framesOfType('game_cancelled').length === 1);

    // Start again, then force the clock past the window → cancel is rejected.
    a2.emit('message', JSON.stringify({ type: 'start' }));
    await sleep(30);
    room2.startedAtMs = Date.now() - 999_999; // simulate window elapsed
    b2.sent.length = 0;
    b2.emit('message', JSON.stringify({ type: 'cancel_game' }));
    await sleep(30);
    check('abort past window is grace_window_closed', b2.framesOfType('error').some((e) => e.code === 'grace_window_closed'));
    check('abort past window did NOT broadcast game_cancelled', b2.framesOfType('game_cancelled').length === 0);

    // ===== Scenario 3: kick (host-only) =====
    const countLob2 = async () =>
        (await db.prepare(`SELECT current_players FROM lobbies WHERE id = ?`).bind(lob2)
            .first<{ current_players: number }>())?.current_players;
    const membersLob2 = async () =>
        (await db.prepare(`SELECT user_id FROM lobby_members WHERE lobby_id = ?`).bind(lob2)
            .all<{ user_id: string }>()).results.map((r) => r.user_id);

    // A non-host (C) trying to kick → forbidden, nobody removed.
    c2.sent.length = 0;
    c2.emit('message', JSON.stringify({ type: 'kick', user_id: 'B' }));
    await sleep(30);
    check('non-host kick is forbidden', c2.framesOfType('error').some((e) => e.code === 'forbidden'));
    check('forbidden kick removed nobody', (await membersLob2()).includes('B'));

    // Host (A) kicks B → B gets `kicked`, socket closes, member_left + DB cleanup.
    a2.emit('message', JSON.stringify({ type: 'kick', user_id: 'B' }));
    await sleep(60);
    check('kicked target got a `kicked` frame', b2.framesOfType('kicked').length === 1);
    check('kicked target socket closed', b2.readyState === 3);
    check('others saw member_left for B', c2.framesOfType('member_left').some((f) => f.user_id === 'B'));
    check('B removed from lobby_members', !(await membersLob2()).includes('B'));
    // current_players is recomputed to the real remaining member count (A, C).
    check('current_players recomputed to real count', (await countLob2()) === (await membersLob2()).length);

    db.close();
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
