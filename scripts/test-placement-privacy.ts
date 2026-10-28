/**
 * Standalone verification that a rating still being PLACED leaves the room only towards its owner
 * (src/elo/placementPrivacy.ts), through the real frames. Run:
 * `npx tsx scripts/test-placement-privacy.ts`.
 *
 * Same rig as scripts/test-host-migration.ts: an in-memory SQLite DB + a mock kv + mock
 * WebSockets driven straight through LobbyRoom. The unit tests pin each redactor; this pins that
 * the room actually CALLS them — on `room_state`, on `member_joined`, on the odds, and on the
 * per-recipient match report — which a pure test cannot see.
 *
 * Cast: P is placed on the 1v1 ladder (14 rated matches, 1610). Q is 3 matches into placement
 * (1380). Both are in one competitive 1v1 room.
 */
import { EventEmitter } from 'node:events';
import { LobbyRoomRegistry } from '../src/lobbies/LobbyRoom';
import { resultParticipantsFor } from '../src/elo/placementPrivacy';
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
    raw: string[] = [];
    send(data: string): void { this.raw.push(data); this.sent.push(JSON.parse(data)); }
    close(): void { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
    framesOfType(t: string): any[] { return this.sent.filter((f) => f.type === t); }
    last(t: string): any { const fs = this.framesOfType(t); return fs[fs.length - 1]; }
}

async function main(): Promise<void> {
    const db = new Db(':memory:');
    db.migrate('migrations');
    const raw = db.raw();

    const lobbyId = 'lobPRIV1';
    for (const id of ['P', 'Q']) {
        raw.prepare(
            `INSERT INTO users (id, discord_id, discord_username, display_name) VALUES (?, ?, ?, ?)`,
        ).run(id, `dc-${id}`, `User${id}`, `User${id}`);
    }
    raw.prepare(
        `INSERT INTO player_ratings (user_id, mode, rating, rd, volatility, games_played, last_rated_at)
         VALUES ('P', 'default', 1610, 80, 0.06, 14, datetime('now')),
                ('Q', 'default', 1380, 210, 0.06, 3, datetime('now'))`,
    ).run();
    raw.prepare(
        `INSERT INTO lobbies (id, host_user_id, title, mod_id, mod_combined_hash, max_players,
                              current_players, status, competitive)
         VALUES (?, 'P', 'Test', 'wol', 'hash', 2, 2, 'open', 1)`,
    ).run(lobbyId);
    for (const [id, joined] of [['P', '01'], ['Q', '02']] as const) {
        raw.prepare(
            `INSERT INTO lobby_members (lobby_id, user_id, joined_at, role) VALUES (?, ?, ?, 'player')`,
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
        globalChat: { refreshPlayers: () => {} },
    } as unknown as AppContext;

    const registry = new LobbyRoomRegistry();
    const room: any = registry.getOrCreate(lobbyId, 'P');

    async function connect(userId: string): Promise<MockWs> {
        const ws = new MockWs();
        room.handleConnection(ws as any, ctx);
        const token = `tok-${lobbyId}-${userId}-${Math.random()}`;
        kvStore.set(`lobby:join:${token}`, JSON.stringify({ userId, lobbyId }));
        ws.emit('message', JSON.stringify({ type: 'hello', join_token: token }));
        await sleep(40);
        return ws;
    }

    const wsP = await connect('P');
    const wsQ = await connect('Q');

    // ---- room_state, as each recipient gets it ----
    const stateQ = wsQ.last('room_state');
    check('Q got room_state', !!stateQ);
    check('Q sees his OWN placement rating', stateQ?.members?.Q?.rating === 1380);
    check('Q sees P (placed) with his number', stateQ?.members?.P?.rating === 1610);
    check('Q\'s own flags travel too', stateQ?.members?.Q?.inPlacement === true);

    // ---- member_joined: P hears Q arrive ----
    const joined = wsP.framesOfType('member_joined').find((f) => f.user_id === 'Q');
    check('P got member_joined for Q', !!joined);
    check('THE ONE THAT MATTERS: member_joined carries no rating for a placing player',
        joined !== undefined && !('rating' in joined) && !('rd' in joined));
    check('member_joined still says WHY (progress and flag)',
        joined?.games_played === 3 && joined?.in_placement === true);

    // ---- odds: hidden on purpose, not merely absent ----
    const oddsP = wsP.last('room_odds');
    check('room_odds hidden while Q places', oddsP?.players === null && oddsP?.hidden_reason === 'placement');
    check('Q\'s room_state odds hidden the same way', stateQ?.odds?.hidden_reason === 'placement');
    check('no frame P received carries 1380',
        wsP.raw.every((s) => !s.includes('1380')));

    // ---- a reconnect: P's fresh room_state, after Q is in the room ----
    const wsP2 = await connect('P');
    const stateP = wsP2.last('room_state');
    check('P\'s reconnect room_state has Q without his number',
        !!stateP?.members?.Q && !('rating' in stateP.members.Q) && !('rd' in stateP.members.Q));
    check('...and P with his own', stateP?.members?.P?.rating === 1610);
    check('the live roster was never redacted (Q still reaches himself)',
        room.members?.Q?.rating === 1380);

    // ---- the match report, one frame per recipient ----
    const participants = [
        { user_id: 'P', result: 0, rating_before: 1610, rating_after: 1590, placement_played: 10, placement_required: 10 },
        { user_id: 'Q', result: 1, rating_before: 1380, rating_after: 1420, placement_played: 4, placement_required: 10 },
    ];
    registry.publishPerUser(lobbyId, (recipientId) => ({
        type: 'match_reported',
        match_id: 'm1',
        participants: resultParticipantsFor(participants, recipientId),
    }));
    await sleep(10);
    const reportP = wsP2.last('match_reported');
    const reportQ = wsQ.last('match_reported');
    const qSeenByP = reportP?.participants?.find((p: any) => p.user_id === 'Q');
    const qSeenByQ = reportQ?.participants?.find((p: any) => p.user_id === 'Q');
    check('match_reported reached both', !!reportP && !!reportQ);
    check('P\'s copy: Q\'s result and progress, no rating',
        qSeenByP?.result === 1 && qSeenByP?.placement_played === 4 && !('rating_after' in (qSeenByP ?? {})));
    check('Q\'s copy: his own rating', qSeenByQ?.rating_after === 1420);
    check('P\'s copy keeps P\'s own (placed) rating',
        reportP?.participants?.find((p: any) => p.user_id === 'P')?.rating_after === 1590);

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
