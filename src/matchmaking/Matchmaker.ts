/**
 * The quick-match queue (docs/DISENO-PARTIDA-RAPIDA.md §7, launcher repo).
 *
 * A player who asks for a quick match gets a TICKET; two compatible tickets become a PROPOSAL
 * that both have 20 s to accept; when both accept, the server opens a room only those two may
 * enter, and tells them where it is. The queue is also PUBLIC: every launcher that speaks the
 * feature receives the list of who is searching, and anybody may challenge a searcher directly
 * (no rating window), which is what makes a small community's queue look alive.
 *
 * Rules that shaped it:
 *  - **No periodic timer.** The server has none by house rule. Pairing runs on events — a join,
 *    a leave, an answer, and the `mm_ping` each searcher sends every 15 s, which is also what
 *    widens the windows. Deadlines are one-shot timers per proposal, per ticket.
 *  - **Everything here is in memory.** A restart empties the queue and the launcher re-enters on
 *    its own. Only the room whitelist and the strikes are stored (migration 0031).
 *  - **Everything that touches the database or the sockets goes through `MmStore` / `MmTransport`,**
 *    so the whole flow can be driven by a test with a fake clock (Matchmaker.test.ts).
 */
import { randomUUID } from 'node:crypto';
import {
    ACCEPT_WINDOW_MS, DISCORD_AFTER_MS, GIVE_UP_AFTER_MS, RECONNECT_GRACE_MS, ROOM_ENTRY_MS, STALE_AFTER_MS,
    chooseHost, compatible, decayedStrikes, lockForStrike, parseKind, pickPair, playKindFor,
    type MmKind, type MmPlayKind, type MmTicket,
} from './pairing';

/** A searcher's public face, as the launcher draws it in the rooms list and on the found card. */
export interface MmProfile {
    displayName: string;
    avatarUrl: string | null;
    /** 1v1 ladder position, 0 = not on the ladder, undefined = unknown. */
    ladderRank?: number;
    badgeMode?: string;
    gamesPlayed: number;
}

export interface MmPlayerState {
    inRoom: boolean;
    inGame: boolean;
}

export interface MmPenalty {
    strikes: number;
    lastStrikeAt: number;
    lockedUntil: number;
}

/** What the queue needs from the database and the rest of the server. */
export interface MmStore {
    playerState(userId: string): Promise<MmPlayerState>;
    rating(userId: string): Promise<{ rating: number; placing: boolean }>;
    profile(userId: string): Promise<MmProfile>;
    isRankedMod(modId: string): boolean;
    penalty(userId: string): Promise<MmPenalty>;
    savePenalty(userId: string, p: MmPenalty): Promise<void>;
    /** Opens the room for a matched pair and records the whitelist. Returns the lobby id. */
    openRoom(input: {
        matchId: string; hostUserId: string; players: string[]; modId: string; modHash: string;
        kind: MmPlayKind; names: string[];
    }): Promise<{ lobbyId: string; competitive: boolean }>;
    /** Who is in the room now, and its status ('open' | 'locked' | 'in_game' | 'closed' | null). */
    roomState(lobbyId: string): Promise<{ status: string | null; members: string[] }>;
    /** Closes a room nobody started. */
    closeRoom(lobbyId: string): Promise<void>;
    announceSearching(ticket: MmTicket, profile: MmProfile): void;
    withdrawSearching(ticketId: string): void;
}

export interface MmTransport {
    /** Sends to the user's one global socket. False when he has none. */
    sendTo(userId: string, frame: object): boolean;
    /** Sends to every socket that declared the `matchmaking` feature. */
    broadcastFeature(frame: object): void;
}

export interface MmClock {
    now(): number;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(handle: unknown): void;
}

export const realClock: MmClock = {
    now: () => Date.now(),
    setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms);
        (t as { unref?: () => void }).unref?.();
        return t;
    },
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface LiveTicket extends MmTicket {
    profile: MmProfile;
    lastSeen: number;
    proposalId: string | null;
    discordTimer: unknown;
    discordPosted: boolean;
    graceTimer: unknown;
}

interface Proposal {
    id: string;
    kind: MmPlayKind;
    modId: string;
    modHash: string;
    /** The two players. A challenger who was not searching has no ticket. */
    players: { userId: string; ticket: LiveTicket | null; profile: MmProfile; rating: number; placing: boolean;
        radminReady: boolean; hostOk: boolean; queuedAt: number }[];
    accepted: Set<string>;
    challenge: boolean;
    timer: unknown;
    settled: boolean;
}

export const JOINS_PER_MINUTE = 10;
export const CHALLENGES_PER_MINUTE = 6;
const SEARCHERS_DEBOUNCE_MS = 400;

export class Matchmaker {
    private tickets = new Map<string, LiveTicket>(); // by userId
    private proposals = new Map<string, Proposal>();
    private rate = new Map<string, { start: number; joins: number; challenges: number }>();
    private searchersTimer: unknown = null;
    private enterTimers = new Map<string, unknown>();

    constructor(
        private readonly store: MmStore,
        private readonly transport: MmTransport,
        private readonly clock: MmClock = realClock,
        private readonly log: (msg: string) => void = () => { /* silent */ },
    ) {}

    // ---------- reads ----------------------------------------------------

    /** Everybody searching, as the launcher lists them. Ratings of placing players omitted. */
    searchers(): object[] {
        const now = this.clock.now();
        return [...this.tickets.values()]
            .filter((t) => now - t.queuedAt < GIVE_UP_AFTER_MS)
            .sort((a, b) => a.queuedAt - b.queuedAt)
            .map((t) => ({
                ticket_id: t.id,
                user_id: t.userId,
                display_name: t.profile.displayName,
                avatar_url: t.profile.avatarUrl,
                ...(t.profile.ladderRank !== undefined ? { ladder_rank: t.profile.ladderRank } : {}),
                ...(t.profile.badgeMode ? { badge_mode: t.profile.badgeMode } : {}),
                ...(t.placing ? {} : { rating: Math.round(t.rating) }),
                games_played: t.profile.gamesPlayed,
                in_placement: t.placing,
                mod_id: t.modId,
                mod_combined_hash: t.modHash,
                kind: t.kind,
                queued_at: new Date(t.queuedAt).toISOString(),
                busy: t.proposalId !== null,
            }));
    }

    /** Counts per (mod, kind), for GET /matchmaking/status. */
    queues(): { mod_id: string; kind: MmKind; searching: number }[] {
        const by = new Map<string, { mod_id: string; kind: MmKind; searching: number }>();
        for (const t of this.tickets.values()) {
            const key = `${t.modId.toLowerCase()}|${t.kind}`;
            const e = by.get(key) ?? { mod_id: t.modId, kind: t.kind, searching: 0 };
            e.searching++;
            by.set(key, e);
        }
        return [...by.values()];
    }

    isQueued(userId: string): boolean {
        return this.tickets.has(userId);
    }

    // ---------- frames from the launcher ---------------------------------

    async join(userId: string, f: Record<string, unknown>): Promise<void> {
        const now = this.clock.now();
        if (!this.allow(userId, 'joins', JOINS_PER_MINUTE)) {
            this.error(userId, 'rate_limited', 'Too many searches, wait a minute.');
            return;
        }
        const kind = parseKind(f.kind) ?? (f.format === '1v1' ? 'ranked' : null);
        const modId = typeof f.mod_id === 'string' ? f.mod_id.trim() : '';
        const modHash = typeof f.mod_combined_hash === 'string' ? f.mod_combined_hash.trim() : '';
        if (!kind || !modId || !modHash || modId.length > 64 || modHash.length > 256) {
            this.error(userId, 'bad_request', 'mm_join needs mod_id, mod_combined_hash and kind.');
            return;
        }

        const existing = this.tickets.get(userId);
        if (existing?.proposalId) {
            // Already being matched: the answer he is waiting for is the found card, not a new ticket.
            this.sendQueued(existing);
            return;
        }

        const pen = await this.currentPenalty(userId, now);
        if (pen.lockedUntil > now) {
            this.error(userId, 'penalty', 'You declined or missed a match a moment ago.', { until: new Date(pen.lockedUntil).toISOString() });
            return;
        }
        const st = await this.store.playerState(userId);
        if (st.inGame) { this.error(userId, 'in_game', 'You are in a match.'); return; }
        if (st.inRoom) { this.error(userId, 'in_room', 'Leave your room first.'); return; }
        if (kind === 'ranked' && !this.store.isRankedMod(modId)) {
            this.error(userId, 'mod_not_ranked', 'This mod has no ladder.');
            return;
        }
        // `either` on a mod without a ladder is simply casual.
        const effKind: MmKind = kind === 'either' && !this.store.isRankedMod(modId) ? 'casual' : kind;

        const radminReady = f.radmin_ready === true;
        const hostOk = f.host_ok !== false;

        if (existing) {
            const sameKey = existing.modId === modId && existing.modHash === modHash && existing.kind === effKind;
            existing.radminReady = radminReady;
            existing.hostOk = hostOk;
            existing.lastSeen = now;
            if (!sameKey) {
                existing.modId = modId; existing.modHash = modHash; existing.kind = effKind;
                existing.queuedAt = now;
            }
            this.cancelGrace(existing);
            this.sendQueued(existing);
            this.searchersChanged();
            this.tryMatch();
            return;
        }

        const [r, profile] = await Promise.all([this.store.rating(userId), this.store.profile(userId)]);
        // The awaits above may have let a second mm_join through.
        if (this.tickets.has(userId)) { this.sendQueued(this.tickets.get(userId)!); return; }
        const t: LiveTicket = {
            id: randomUUID(), userId, modId, modHash, kind: effKind,
            rating: r.rating, placing: r.placing, queuedAt: now, radminReady, hostOk,
            profile, lastSeen: now, proposalId: null, discordTimer: null, discordPosted: false, graceTimer: null,
        };
        this.tickets.set(userId, t);
        t.discordTimer = this.clock.setTimer(() => this.maybeAnnounce(t), DISCORD_AFTER_MS);
        this.log(`mm: ${userId} queued ${modId}/${effKind}`);
        this.sendQueued(t);
        this.searchersChanged();
        this.tryMatch();
    }

    leave(userId: string, reason: 'left' | 'in_room' | 'timeout' | 'disconnected' | 'stale' = 'left'): void {
        const t = this.tickets.get(userId);
        if (!t) return;
        if (t.proposalId) {
            // Leaving while a match is being proposed is a decline.
            const p = this.proposals.get(t.proposalId);
            if (p && !p.settled) {
                void this.resolveDeclined(p, new Set([userId]), reason === 'left' ? 'declined' : 'player_left');
                return;
            }
        }
        this.drop(t);
        this.transport.sendTo(userId, { type: 'mm_left', reason });
        this.searchersChanged();
    }

    ping(userId: string): void {
        const t = this.tickets.get(userId);
        if (t) t.lastSeen = this.clock.now();
        this.expire();
        this.tryMatch();
    }

    async challenge(userId: string, f: Record<string, unknown>): Promise<void> {
        const now = this.clock.now();
        if (!this.allow(userId, 'challenges', CHALLENGES_PER_MINUTE)) {
            this.error(userId, 'rate_limited', 'Too many challenges, wait a minute.');
            return;
        }
        const ticketId = typeof f.ticket_id === 'string' ? f.ticket_id : '';
        const modHash = typeof f.mod_combined_hash === 'string' ? f.mod_combined_hash.trim() : '';
        const target = [...this.tickets.values()].find((t) => t.id === ticketId);
        if (!target) { this.error(userId, 'not_searching', 'That player is no longer searching.'); return; }
        if (target.userId === userId) return;
        if (target.proposalId) { this.error(userId, 'busy', 'That player is being matched right now.'); return; }
        if (!modHash || modHash.toLowerCase() !== target.modHash.toLowerCase()) {
            this.error(userId, 'mod_mismatch', 'You have another version of that mod.', { mod_id: target.modId });
            return;
        }
        const mine = this.tickets.get(userId);
        if (mine?.proposalId) { this.error(userId, 'busy', 'You are being matched right now.'); return; }
        const pen = await this.currentPenalty(userId, now);
        if (pen.lockedUntil > now) {
            this.error(userId, 'penalty', 'You declined or missed a match a moment ago.', { until: new Date(pen.lockedUntil).toISOString() });
            return;
        }
        const st = await this.store.playerState(userId);
        if (st.inGame) { this.error(userId, 'in_game', 'You are in a match.'); return; }
        if (st.inRoom) { this.error(userId, 'in_room', 'Leave your room first.'); return; }
        // The awaits may have let the target be matched meanwhile.
        if (target.proposalId || this.tickets.get(target.userId) !== target) {
            this.error(userId, 'busy', 'That player is being matched right now.');
            return;
        }

        const kind = playKindFor(target.kind, this.store.isRankedMod(target.modId));
        let challenger: Proposal['players'][number];
        if (mine && mine.modHash.toLowerCase() === target.modHash.toLowerCase()) {
            challenger = this.member(mine);
        } else {
            const [r, profile] = await Promise.all([this.store.rating(userId), this.store.profile(userId)]);
            if (target.proposalId) { this.error(userId, 'busy', 'That player is being matched right now.'); return; }
            challenger = {
                userId, ticket: null, profile, rating: r.rating, placing: r.placing,
                radminReady: f.radmin_ready === true, hostOk: f.host_ok !== false, queuedAt: now,
            };
        }
        this.log(`mm: ${userId} challenges ${target.userId}`);
        this.propose([challenger, this.member(target)], kind, target.modId, target.modHash, true);
    }

    async accept(userId: string, f: Record<string, unknown>): Promise<void> {
        const p = this.proposals.get(typeof f.match_id === 'string' ? f.match_id : '');
        if (!p || p.settled || !p.players.some((m) => m.userId === userId)) return;
        p.accepted.add(userId);
        for (const m of p.players) {
            this.transport.sendTo(m.userId, {
                type: 'mm_accept_progress', match_id: p.id, accepted: p.accepted.size, total: p.players.length,
            });
        }
        if (p.accepted.size === p.players.length) await this.openRoom(p);
    }

    decline(userId: string, f: Record<string, unknown>): void {
        const p = this.proposals.get(typeof f.match_id === 'string' ? f.match_id : '');
        if (!p || p.settled || !p.players.some((m) => m.userId === userId)) return;
        void this.resolveDeclined(p, new Set([userId]), 'declined');
    }

    // ---------- the socket coming and going ------------------------------

    /** The user's global socket closed. His ticket waits RECONNECT_GRACE_MS for him. */
    socketGone(userId: string): void {
        const t = this.tickets.get(userId);
        if (!t || t.proposalId) return;
        this.cancelGrace(t);
        t.graceTimer = this.clock.setTimer(() => {
            t.graceTimer = null;
            if (this.tickets.get(userId) === t && !t.proposalId) this.leave(userId, 'disconnected');
        }, RECONNECT_GRACE_MS);
    }

    /** He is back: keep the ticket, tell him so. */
    socketBack(userId: string): void {
        const t = this.tickets.get(userId);
        if (!t) return;
        this.cancelGrace(t);
        t.lastSeen = this.clock.now();
        this.sendQueued(t);
    }

    // ---------- internals ------------------------------------------------

    private member(t: LiveTicket): Proposal['players'][number] {
        return {
            userId: t.userId, ticket: t, profile: t.profile, rating: t.rating, placing: t.placing,
            radminReady: t.radminReady, hostOk: t.hostOk, queuedAt: t.queuedAt,
        };
    }

    private tryMatch(): void {
        const now = this.clock.now();
        for (;;) {
            const free = [...this.tickets.values()].filter((t) => !t.proposalId);
            const pair = pickPair(free, now);
            if (!pair) return;
            const a = this.tickets.get(pair.a.userId)!;
            const b = this.tickets.get(pair.b.userId)!;
            this.propose([this.member(a), this.member(b)], pair.kind, a.modId, a.modHash, false);
        }
    }

    private propose(players: Proposal['players'], kind: MmPlayKind, modId: string, modHash: string, challenge: boolean): void {
        const p: Proposal = {
            id: randomUUID(), kind, modId, modHash, players, accepted: new Set(), challenge, timer: null, settled: false,
        };
        this.proposals.set(p.id, p);
        for (const m of players) if (m.ticket) m.ticket.proposalId = p.id;
        const hostId = chooseHost(players[0]!, players[1]!);
        p.timer = this.clock.setTimer(() => {
            if (p.settled) return;
            const silent = new Set(p.players.filter((m) => !p.accepted.has(m.userId)).map((m) => m.userId));
            void this.resolveDeclined(p, silent, 'timeout');
        }, ACCEPT_WINDOW_MS);

        for (const m of players) {
            const other = players.find((o) => o.userId !== m.userId)!;
            const delivered = this.transport.sendTo(m.userId, {
                type: 'mm_found',
                match_id: p.id,
                kind,
                mod_id: modId,
                challenge,
                challenger: challenge && players[0]!.userId === m.userId,
                accept_deadline_ms: ACCEPT_WINDOW_MS,
                you_are_host: hostId === m.userId,
                opponent: {
                    user_id: other.userId,
                    display_name: other.profile.displayName,
                    avatar_url: other.profile.avatarUrl,
                    ...(other.profile.ladderRank !== undefined ? { ladder_rank: other.profile.ladderRank } : {}),
                    ...(other.profile.badgeMode ? { badge_mode: other.profile.badgeMode } : {}),
                    ...(other.placing ? {} : { rating: Math.round(other.rating) }),
                    games_played: other.profile.gamesPlayed,
                    in_placement: other.placing,
                },
            });
            // Nobody to ask: treat it as a decline now rather than waiting out the clock.
            if (!delivered) {
                void this.resolveDeclined(p, new Set([m.userId]), 'player_left');
                return;
            }
        }
        this.log(`mm: proposed ${p.id} ${players.map((m) => m.userId).join(' vs ')} (${kind}${challenge ? ', challenge' : ''})`);
        this.searchersChanged();
    }

    private async resolveDeclined(p: Proposal, decliners: Set<string>, reason: 'declined' | 'timeout' | 'player_left'): Promise<void> {
        if (p.settled) return;
        p.settled = true;
        this.clock.clearTimer(p.timer);
        this.proposals.delete(p.id);
        const now = this.clock.now();
        for (const m of p.players) {
            if (decliners.has(m.userId)) {
                if (m.ticket) this.drop(m.ticket);
                // A player whose launcher vanished mid-proposal is not punished: that is a crash,
                // not a choice. Declining and letting the clock run out are.
                const strike = reason === 'player_left' ? null : await this.strike(m.userId, now);
                this.transport.sendTo(m.userId, {
                    type: 'mm_cancelled', match_id: p.id, reason, requeued: false,
                    you: true,
                    ...(strike ? { strikes: strike.strikes, locked_until: strike.lockedUntil > now ? new Date(strike.lockedUntil).toISOString() : null } : {}),
                });
            } else {
                // Back in the queue, keeping his place.
                if (m.ticket && this.tickets.get(m.userId) === m.ticket) m.ticket.proposalId = null;
                this.transport.sendTo(m.userId, {
                    type: 'mm_cancelled', match_id: p.id, reason, requeued: m.ticket !== null, you: false,
                });
            }
        }
        this.log(`mm: ${p.id} cancelled (${reason})`);
        this.searchersChanged();
        this.tryMatch();
    }

    private async openRoom(p: Proposal): Promise<void> {
        if (p.settled) return;
        p.settled = true;
        this.clock.clearTimer(p.timer);
        this.proposals.delete(p.id);
        for (const m of p.players) if (m.ticket) this.drop(m.ticket);
        this.searchersChanged();
        const hostId = chooseHost(p.players[0]!, p.players[1]!);
        try {
            const room = await this.store.openRoom({
                matchId: p.id, hostUserId: hostId, players: p.players.map((m) => m.userId),
                modId: p.modId, modHash: p.modHash, kind: p.kind,
                names: p.players.map((m) => m.profile.displayName),
            });
            for (const m of p.players) {
                this.transport.sendTo(m.userId, {
                    type: 'mm_room_ready', match_id: p.id, lobby_id: room.lobbyId, host_user_id: hostId,
                    competitive: room.competitive,
                });
            }
            this.log(`mm: ${p.id} room ${room.lobbyId}`);
            this.enterTimers.set(room.lobbyId, this.clock.setTimer(() => void this.checkEntered(p, room.lobbyId), ROOM_ENTRY_MS));
        } catch (err) {
            this.log(`mm: ${p.id} room failed: ${String(err)}`);
            for (const m of p.players) {
                this.transport.sendTo(m.userId, { type: 'mm_cancelled', match_id: p.id, reason: 'room_failed', requeued: false, you: false });
            }
        }
    }

    /** Someone matched never came in: close the room, strike the absent, free the present. */
    private async checkEntered(p: Proposal, lobbyId: string): Promise<void> {
        this.enterTimers.delete(lobbyId);
        let st: { status: string | null; members: string[] };
        try { st = await this.store.roomState(lobbyId); } catch { return; }
        if (st.status !== 'open' && st.status !== 'locked') return;
        const absent = p.players.filter((m) => !st.members.includes(m.userId)).map((m) => m.userId);
        if (absent.length === 0) return;
        try { await this.store.closeRoom(lobbyId); } catch { /* the orphan paths close it anyway */ }
        const now = this.clock.now();
        for (const m of p.players) {
            const isAbsent = absent.includes(m.userId);
            if (isAbsent) await this.strike(m.userId, now);
            this.transport.sendTo(m.userId, {
                type: 'mm_cancelled', match_id: p.id, reason: 'room_failed', requeued: false, you: isAbsent,
            });
        }
        this.log(`mm: ${p.id} room ${lobbyId} closed, absent ${absent.join(',')}`);
    }

    private expire(): void {
        const now = this.clock.now();
        for (const t of [...this.tickets.values()]) {
            if (t.proposalId) continue;
            if (now - t.queuedAt >= GIVE_UP_AFTER_MS) this.leave(t.userId, 'timeout');
            else if (now - t.lastSeen >= STALE_AFTER_MS && !t.graceTimer) this.leave(t.userId, 'stale');
        }
    }

    private drop(t: LiveTicket): void {
        if (this.tickets.get(t.userId) === t) this.tickets.delete(t.userId);
        this.clock.clearTimer(t.discordTimer);
        this.cancelGrace(t);
        if (t.discordPosted) this.store.withdrawSearching(t.id);
        t.discordPosted = false;
    }

    private cancelGrace(t: LiveTicket): void {
        if (t.graceTimer) { this.clock.clearTimer(t.graceTimer); t.graceTimer = null; }
    }

    private maybeAnnounce(t: LiveTicket): void {
        t.discordTimer = null;
        if (this.tickets.get(t.userId) !== t || t.proposalId) return;
        try { this.store.announceSearching(t, t.profile); t.discordPosted = true; } catch { /* best-effort */ }
    }

    private async currentPenalty(userId: string, now: number): Promise<MmPenalty> {
        try {
            const p = await this.store.penalty(userId);
            return { ...p, strikes: decayedStrikes(p.strikes, p.lastStrikeAt, now) };
        } catch {
            return { strikes: 0, lastStrikeAt: 0, lockedUntil: 0 };
        }
    }

    private async strike(userId: string, now: number): Promise<MmPenalty> {
        const cur = await this.currentPenalty(userId, now);
        const strikes = cur.strikes + 1;
        const lock = lockForStrike(strikes);
        const next: MmPenalty = { strikes, lastStrikeAt: now, lockedUntil: lock > 0 ? now + lock : cur.lockedUntil };
        try { await this.store.savePenalty(userId, next); } catch { /* a lost strike is a lost strike */ }
        return next;
    }

    private allow(userId: string, what: 'joins' | 'challenges', perMinute: number): boolean {
        const now = this.clock.now();
        let r = this.rate.get(userId);
        if (!r || now - r.start > 60_000) { r = { start: now, joins: 0, challenges: 0 }; this.rate.set(userId, r); }
        r[what]++;
        return r[what] <= perMinute;
    }

    private sendQueued(t: LiveTicket): void {
        const same = [...this.tickets.values()].filter((o) => compatible(o, t) !== null || o === t).length;
        this.transport.sendTo(t.userId, {
            type: 'mm_queued', ticket_id: t.id, mod_id: t.modId, kind: t.kind,
            queued_at: new Date(t.queuedAt).toISOString(), searching: same,
        });
    }

    private error(userId: string, code: string, message: string, extra: Record<string, unknown> = {}): void {
        this.transport.sendTo(userId, { type: 'mm_error', code, message, ...extra });
    }

    private searchersChanged(): void {
        if (this.searchersTimer) return;
        this.searchersTimer = this.clock.setTimer(() => {
            this.searchersTimer = null;
            try { this.transport.broadcastFeature({ type: 'mm_searchers_changed', searchers: this.searchers() }); }
            catch { /* best-effort */ }
        }, SEARCHERS_DEBOUNCE_MS);
    }
}
