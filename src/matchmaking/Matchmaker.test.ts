/**
 * The quick-match queue end to end, with a fake clock, a fake database and fake sockets.
 * Run: `npm test`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Matchmaker, type MmClock, type MmPenalty, type MmStore, type MmTransport } from './Matchmaker.js';

interface Frame { type: string; [k: string]: unknown }

function harness(opts: { ratings?: Record<string, number>; placing?: string[]; inRoom?: string[]; unranked?: string[] } = {}) {
    let now = 1_000_000;
    let seq = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const clock: MmClock = {
        now: () => now,
        setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
        clearTimer: (h) => { timers.delete(h as number); },
    };
    const advance = async (ms: number) => {
        const until = now + ms;
        for (;;) {
            const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            timers.delete(due[0]);
            now = due[1].at;
            due[1].fn();
            await flush();
        }
        now = until;
    };
    const flush = () => new Promise((r) => setImmediate(r));

    const inbox = new Map<string, Frame[]>();
    const online = new Set<string>();
    const broadcasts: Frame[] = [];
    const transport: MmTransport = {
        sendTo: (u, f) => {
            if (!online.has(u)) return false;
            (inbox.get(u) ?? inbox.set(u, []).get(u)!).push(f as Frame);
            return true;
        },
        broadcastFeature: (f) => { broadcasts.push(f as Frame); },
    };

    const penalties = new Map<string, MmPenalty>();
    const rooms: { lobbyId: string; matchId: string; players: string[]; host: string; members: string[]; status: string }[] = [];
    const announced: string[] = [];
    const withdrawn: string[] = [];
    const store: MmStore = {
        playerState: async (u) => ({ inRoom: (opts.inRoom ?? []).includes(u), inGame: false }),
        rating: async (u) => ({ rating: opts.ratings?.[u] ?? 1500, placing: (opts.placing ?? []).includes(u) }),
        profile: async (u) => ({ displayName: u.toUpperCase(), avatarUrl: null, gamesPlayed: 20 }),
        isRankedMod: (m) => !(opts.unranked ?? []).includes(m),
        penalty: async (u) => penalties.get(u) ?? { strikes: 0, lastStrikeAt: 0, lockedUntil: 0 },
        savePenalty: async (u, p) => { penalties.set(u, p); },
        openRoom: async (i) => {
            const r = { lobbyId: `L${rooms.length + 1}`, matchId: i.matchId, players: i.players, host: i.hostUserId,
                members: [i.hostUserId], status: 'open' };
            rooms.push(r);
            return { lobbyId: r.lobbyId, competitive: i.kind === 'ranked' };
        },
        roomState: async (id) => {
            const r = rooms.find((x) => x.lobbyId === id);
            return { status: r?.status ?? null, members: r?.members ?? [] };
        },
        closeRoom: async (id) => { const r = rooms.find((x) => x.lobbyId === id); if (r) r.status = 'closed'; },
        announceSearching: (t) => { announced.push(t.userId); },
        withdrawSearching: (id) => { withdrawn.push(id); },
    };
    const mm = new Matchmaker(store, transport, clock);
    const last = (u: string, type: string) => [...(inbox.get(u) ?? [])].reverse().find((f) => f.type === type);
    const join = async (u: string, extra: Record<string, unknown> = {}) => {
        online.add(u);
        await mm.join(u, { mod_id: 'wol', mod_combined_hash: 'H', kind: 'ranked', ...extra });
        await flush();
    };
    return { mm, join, last, advance, flush, inbox, online, rooms, penalties, broadcasts, announced, withdrawn, now: () => now };
}

test('THE ONE THAT MATTERS: two searchers are found, both accept, and get the same room', async () => {
    const h = harness();
    await h.join('a');
    await h.join('b');
    const fa = h.last('a', 'mm_found')!;
    const fb = h.last('b', 'mm_found')!;
    assert.ok(fa && fb, 'both are told');
    assert.equal(fa.match_id, fb.match_id);
    assert.equal((fa.opponent as { user_id: string }).user_id, 'b');
    assert.equal(fa.accept_deadline_ms, 20_000);
    assert.notEqual(fa.you_are_host, fb.you_are_host, 'exactly one hosts');

    await h.mm.accept('a', { match_id: fa.match_id });
    assert.equal(h.last('b', 'mm_accept_progress')!.accepted, 1);
    await h.mm.accept('b', { match_id: fa.match_id });
    await h.flush();
    const ra = h.last('a', 'mm_room_ready')!;
    const rb = h.last('b', 'mm_room_ready')!;
    assert.equal(ra.lobby_id, rb.lobby_id);
    assert.equal(ra.competitive, true);
    assert.equal(h.rooms[0]!.players.length, 2);
    assert.equal(h.mm.searchers().length, 0, 'nobody is listed as searching any more');
});

test('a player who declines gets a strike; the other keeps his place in the queue', async () => {
    const h = harness();
    await h.join('a');
    await h.advance(5_000);
    await h.join('b');
    const id = h.last('a', 'mm_found')!.match_id;
    h.mm.decline('b', { match_id: id });
    await h.flush();
    assert.equal(h.last('b', 'mm_cancelled')!.you, true);
    assert.equal(h.last('a', 'mm_cancelled')!.requeued, true);
    assert.equal(h.penalties.get('b')!.strikes, 1);
    assert.equal(h.penalties.has('a'), false);
    const listed = h.mm.searchers() as { user_id: string; queued_at: string }[];
    assert.deepEqual(listed.map((s) => s.user_id), ['a']);
    assert.equal(Date.parse(listed[0]!.queued_at), 1_000_000, 'his original time');
});

test('letting the 20 s run out is a decline for whoever did not answer', async () => {
    const h = harness();
    await h.join('a');
    await h.join('b');
    await h.mm.accept('a', { match_id: h.last('a', 'mm_found')!.match_id });
    await h.advance(20_000);
    assert.equal(h.last('b', 'mm_cancelled')!.reason, 'timeout');
    assert.equal(h.penalties.get('b')!.strikes, 1);
    assert.equal(h.last('a', 'mm_cancelled')!.requeued, true);
});

test('the second strike locks the queue for two minutes', async () => {
    const h = harness();
    h.penalties.set('b', { strikes: 1, lastStrikeAt: 999_000, lockedUntil: 0 });
    await h.join('a');
    await h.join('b');
    h.mm.decline('b', { match_id: h.last('b', 'mm_found')!.match_id });
    await h.flush();
    await h.join('b');
    assert.equal(h.last('b', 'mm_error')!.code, 'penalty');
    await h.advance(120_000);
    await h.join('b');
    assert.ok(h.last('b', 'mm_queued'));
});

test('ratings too far apart wait until the windows widen', async () => {
    const h = harness({ ratings: { a: 1400, b: 1700 } });
    await h.join('a');
    await h.join('b');
    assert.equal(h.last('a', 'mm_found'), undefined);
    await h.advance(30_000);
    h.mm.ping('a'); h.mm.ping('b');
    assert.equal(h.last('a', 'mm_found'), undefined, '250 each is still short of 300');
    await h.advance(30_000);
    h.mm.ping('b'); h.mm.ping('a');
    assert.ok(h.last('a', 'mm_found'));
});

test('a challenge ignores the window and pairs right away', async () => {
    const h = harness({ ratings: { a: 1200, c: 2000 } });
    await h.join('a');
    h.online.add('c');
    const ticket = (h.mm.searchers()[0] as { ticket_id: string }).ticket_id;
    await h.mm.challenge('c', { ticket_id: ticket, mod_combined_hash: 'H' });
    const fc = h.last('c', 'mm_found')!;
    assert.equal(fc.challenger, true);
    assert.equal(h.last('a', 'mm_found')!.challenger, false);
});

test('a challenge with another version is refused and names it', async () => {
    const h = harness();
    await h.join('a');
    h.online.add('c');
    const ticket = (h.mm.searchers()[0] as { ticket_id: string }).ticket_id;
    await h.mm.challenge('c', { ticket_id: ticket, mod_combined_hash: 'OTHER' });
    assert.equal(h.last('c', 'mm_error')!.code, 'mod_mismatch');
    assert.equal(h.last('a', 'mm_found'), undefined);
});

test('a placing player is listed without his rating', async () => {
    const h = harness({ placing: ['a'] });
    await h.join('a');
    const s = h.mm.searchers()[0] as Record<string, unknown>;
    assert.equal('rating' in s, false);
    assert.equal(s.in_placement, true);
});

test('ranked on a mod without a ladder is refused; either becomes casual', async () => {
    const h = harness({ unranked: ['solo'] });
    await h.join('a', { mod_id: 'solo' });
    assert.equal(h.last('a', 'mm_error')!.code, 'mod_not_ranked');
    await h.join('a', { mod_id: 'solo', kind: 'either' });
    assert.equal(h.last('a', 'mm_queued')!.kind, 'casual');
});

test('somebody already in a room cannot queue', async () => {
    const h = harness({ inRoom: ['a'] });
    await h.join('a');
    assert.equal(h.last('a', 'mm_error')!.code, 'in_room');
});

test('a dropped socket keeps the ticket for 15 s, and a reconnect keeps it for good', async () => {
    const h = harness();
    await h.join('a');
    h.mm.socketGone('a');
    await h.advance(10_000);
    h.mm.socketBack('a');
    await h.advance(30_000);
    assert.equal(h.mm.isQueued('a'), true);
    h.mm.socketGone('a');
    await h.advance(15_000);
    assert.equal(h.mm.isQueued('a'), false);
});

test('somebody who never enters the room is struck and the other is told', async () => {
    const h = harness();
    await h.join('a');
    await h.join('b');
    const id = h.last('a', 'mm_found')!.match_id;
    await h.mm.accept('a', { match_id: id });
    await h.mm.accept('b', { match_id: id });
    await h.flush();
    const room = h.rooms[0]!;
    const absent = room.players.find((p) => p !== room.host)!;
    await h.advance(90_000);
    assert.equal(room.status, 'closed');
    assert.equal(h.penalties.get(absent)!.strikes, 1);
    assert.equal(h.last(room.host, 'mm_cancelled')!.reason, 'room_failed');
});

test('Discord is told after 30 s alone, and the message goes when the search ends', async () => {
    const h = harness();
    await h.join('a');
    await h.advance(30_000);
    assert.deepEqual(h.announced, ['a']);
    h.mm.leave('a');
    assert.equal(h.withdrawn.length, 1);
});

test('a launcher that stopped pinging leaves the queue', async () => {
    const h = harness();
    await h.join('a');
    await h.join('b', { mod_id: 'im' });
    await h.advance(60_000);
    h.mm.ping('b');
    assert.equal(h.mm.isQueued('a'), false);
    assert.equal(h.last('a', 'mm_left')!.reason, 'stale');
});

test('the search gives up after half an hour', async () => {
    const h = harness();
    await h.join('a');
    for (let i = 0; i < 125; i++) { await h.advance(15_000); h.mm.ping('a'); }
    assert.equal(h.last('a', 'mm_left')!.reason, 'timeout');
});

test('everybody who speaks the feature hears that the list changed', async () => {
    const h = harness();
    await h.join('a');
    await h.advance(1_000);
    const f = h.broadcasts.at(-1)!;
    assert.equal(f.type, 'mm_searchers_changed');
    assert.equal((f.searchers as unknown[]).length, 1);
});
