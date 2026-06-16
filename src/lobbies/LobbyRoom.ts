import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { verifyJwt } from '../lib/jwt';
import type { AppContext } from '../context';

/**
 * Per-lobby room state, in-process replacement for the Cloudflare
 * Durable Object that backed the same protocol on the Worker.
 *
 * Big-picture differences vs the original:
 *   * No hibernation. The Node process keeps the room object in RAM
 *     until everyone leaves or the host's REST /leave closes the
 *     lobby. Memory cost per room is trivial (a Map + a chat ring),
 *     and a single VM running this can comfortably hold the few
 *     dozen rooms the launcher's free tier is sized for.
 *   * No <c>serializeAttachment</c> dance — the WS keeps a normal
 *     reference back to its <c>AttachedSocket</c> record on the
 *     server. Reconnects re-issue hello and re-bind from scratch.
 *   * No DO <c>fetch()</c> entry point. The HTTP layer hands raw
 *     WebSockets straight to <c>handleConnection()</c>.
 *
 * Wire protocol — every frame the launcher sends and receives — is
 * 100% unchanged. <c>room_state</c>, <c>chat</c>, <c>member_joined</c>,
 * <c>game_countdown</c>, the peer_announce / peer_relay / game_relay
 * triplet, all of them carry the same JSON shape the Worker emitted.
 */

interface AttachedSocket {
    userId: string;
    discordUsername: string;
    /** Last frame timestamp, used for idle-kick. */
    lastFrameAt: number;
    /** Counts chat frames inside the current minute window for per-user throttling. */
    chatWindowStart: number;
    chatWindowCount: number;
}

interface MemberEntry {
    ready: boolean;
    login: string;
    /**
     * The member's Radmin VPN IP (26.x.x.x), reported by the client via
     * set_radmin_ip once it's actually on the VPN. Lets every peer ICMP-ping
     * every other peer for the in-game per-player ping column. Undefined until
     * reported (the client often isn't on Radmin yet at join time).
     */
    radminIp?: string;
}

interface ChatLine {
    id: string;
    userId: string;
    login: string;
    body: string;
    at: number;
}

const CHAT_RING_MAX = 100;
const IDLE_KICK_AFTER_MS = 90 * 1000;

class LobbyRoom {
    readonly lobbyId: string;
    /**
     * NOT readonly: the host can be reassigned when the current host leaves
     * (GameRanger-style host migration — see reassignHost). room_state emits
     * this, so updating it + broadcasting host_changed moves control to the
     * next member.
     */
    hostUserId: string;
    members: Record<string, MemberEntry> = {};
    chatRing: ChatLine[] = [];
    private attached = new Map<WebSocket, AttachedSocket>();
    /**
     * Wall-clock ms when the host pressed Start (countdown began). Drives the
     * abort grace window in handleCancelGame. In-memory (not the DB started_at)
     * so we compare against Date.now() on the same clock and skip date parsing;
     * the room stays in RAM for the whole match, so it's reliable across the
     * window. Null outside a starting/in-game match.
     */
    private startedAtMs: number | null = null;

    constructor(lobbyId: string, hostUserId: string) {
        this.lobbyId = lobbyId;
        this.hostUserId = hostUserId;
    }

    /**
     * Number of currently-attached sockets. The registry uses this to
     * know when a room has become empty and can be garbage-collected.
     */
    get socketCount(): number {
        return this.attached.size;
    }

    /**
     * Wire an incoming WebSocket into this room. Mirrors the Worker's
     * <c>fetch()</c> + <c>acceptWebSocket()</c> dance — we listen for
     * 'message'/'close'/'error', everything else flows through the
     * handler methods that the DO had.
     */
    handleConnection(ws: WebSocket, ctx: AppContext): void {
        ws.on('message', async (raw, _isBinary) => {
            let frame: unknown;
            try {
                frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
            } catch {
                this.sendError(ws, 'bad_frame', 'Frame is not valid JSON');
                return;
            }
            if (!frame || typeof frame !== 'object' || !('type' in frame)) {
                this.sendError(ws, 'bad_frame', 'Frame missing type');
                return;
            }
            await this.dispatch(ws, ctx, frame as { type: string } & Record<string, unknown>);
        });

        ws.on('close', () => {
            const attached = this.attached.get(ws);
            this.attached.delete(ws);
            if (!attached) return;
            const wasHost = attached.userId === this.hostUserId;
            if (this.members[attached.userId]) {
                delete this.members[attached.userId];
            }
            this.broadcast({ type: 'member_left', user_id: attached.userId }, ws);
            // An abrupt close (crash / alt-F4 / dropped connection) never hits
            // REST /leave, so do the DB bookkeeping here that /leave normally
            // does — for ANYONE, not just the host: a leftover lobby_members row
            // makes the "1 active lobby per user" guard lock them out, and the
            // denormalised current_players never decrements (the lobby list
            // would read full and block joins). Best-effort + fire-and-forget
            // (the 'close' callback can't be awaited).
            void this.handleDisconnectCleanup(ctx, attached.userId, wasHost);
        });

        ws.on('error', () => {
            this.attached.delete(ws);
        });
    }

    private async dispatch(
        ws: WebSocket,
        ctx: AppContext,
        f: { type: string } & Record<string, unknown>,
    ): Promise<void> {
        if (f.type === 'hello') {
            await this.handleHello(ws, ctx, f);
            return;
        }

        const attached = this.attached.get(ws);
        if (!attached) {
            this.sendError(ws, 'unauthenticated', 'Send hello first');
            ws.close(4001, 'unauthenticated');
            return;
        }
        attached.lastFrameAt = Date.now();

        switch (f.type) {
            case 'chat':
                await this.handleChat(ws, ctx, attached, f);
                break;
            case 'ready':
                await this.handleReady(ctx, attached, f);
                break;
            case 'start':
            case 'start_game':
                await this.handleStart(ws, ctx, attached);
                break;
            case 'cancel_game':
                await this.handleCancelGame(ws, ctx, attached, f);
                break;
            case 'set_radmin_ip':
                this.handleSetRadminIp(attached, f);
                break;
            case 'kick':
                this.handleKick(ws, attached, f);
                break;
            case 'ping':
                this.send(ws, { type: 'pong' });
                break;
            case 'peer_announce':
                this.handlePeerAnnounce(attached, f);
                break;
            case 'peer_relay':
                this.handlePeerRelay(attached, f);
                break;
            case 'game_relay':
                this.handleGameRelay(attached, f);
                break;
            default:
                this.sendError(ws, 'unknown_type', `Unknown frame type: ${f.type}`);
        }
    }

    private async handleHello(
        ws: WebSocket,
        ctx: AppContext,
        frame: { type: string } & Record<string, unknown>,
    ): Promise<void> {
        let userId: string | null = null;
        let login = '';

        if (typeof frame.join_token === 'string') {
            const stored = await ctx.kv.get(`lobby:join:${frame.join_token}`);
            if (!stored) {
                this.sendError(ws, 'invalid_join_token', 'Join token missing or expired');
                ws.close(4002, 'invalid_join_token');
                return;
            }
            const parsed = JSON.parse(stored) as { userId: string; lobbyId: string };
            await ctx.kv.delete(`lobby:join:${frame.join_token}`);
            userId = parsed.userId;
            const u = await ctx.db.prepare(
                `SELECT discord_username FROM users WHERE id = ?`,
            ).bind(userId).first<{ discord_username: string }>();
            login = u?.discord_username ?? '';
        } else if (typeof frame.token === 'string') {
            const payload = await verifyJwt(frame.token, ctx.config.jwtSigningKey);
            if (!payload) {
                this.sendError(ws, 'invalid_token', 'JWT invalid');
                ws.close(4003, 'invalid_token');
                return;
            }
            userId = payload.sub;
            login = payload.du;
        } else {
            this.sendError(ws, 'unauthenticated', 'hello frame needs join_token or token');
            ws.close(4001, 'unauthenticated');
            return;
        }

        const member = await ctx.db.prepare(
            `SELECT 1 FROM lobby_members WHERE lobby_id = ? AND user_id = ? LIMIT 1`,
        ).bind(this.lobbyId, userId).first();
        if (!member) {
            this.sendError(ws, 'not_in_lobby', 'You are not a member of this lobby');
            ws.close(4004, 'not_in_lobby');
            return;
        }

        const now = Date.now();
        this.attached.set(ws, {
            userId,
            discordUsername: login,
            lastFrameAt: now,
            chatWindowStart: now,
            chatWindowCount: 0,
        });

        const existing = this.members[userId];
        this.members[userId] = {
            ready: existing?.ready ?? false,
            login,
        };

        this.send(ws, {
            type: 'room_state',
            lobby_id: this.lobbyId,
            host_user_id: this.hostUserId,
            members: this.members,
            chat: this.chatRing,
        });
        this.broadcast({
            type: 'member_joined',
            user_id: userId,
            discord_username: login,
        }, ws);
    }

    private async handleChat(
        ws: WebSocket,
        ctx: AppContext,
        attached: AttachedSocket,
        frame: { type: string } & Record<string, unknown>,
    ): Promise<void> {
        const body = typeof frame.body === 'string' ? frame.body.trim() : '';
        if (!body) return;
        if (body.length > 500) {
            this.sendError(ws, 'chat_too_long', 'Max 500 chars per message');
            return;
        }

        const now = Date.now();
        if (now - attached.chatWindowStart > 60_000) {
            attached.chatWindowStart = now;
            attached.chatWindowCount = 0;
        }
        attached.chatWindowCount += 1;
        if (attached.chatWindowCount > ctx.config.chatMsgsPerMin) {
            this.sendError(ws, 'chat_rate_limited', 'Slow down — chat throttled');
            return;
        }

        const line: ChatLine = {
            id: randomUUID(),
            userId: attached.userId,
            login: attached.discordUsername,
            body,
            at: now,
        };
        this.chatRing.push(line);
        if (this.chatRing.length > CHAT_RING_MAX) this.chatRing.shift();
        this.broadcast({ type: 'chat', line }, null);
    }

    private async handleReady(
        ctx: AppContext,
        attached: AttachedSocket,
        frame: { type: string } & Record<string, unknown>,
    ): Promise<void> {
        const ready = Boolean(frame.ready);
        const existing = this.members[attached.userId];
        this.members[attached.userId] = {
            ready,
            login: existing?.login ?? attached.discordUsername,
        };
        try {
            await ctx.db.prepare(
                `UPDATE lobby_members SET is_ready = ? WHERE lobby_id = ? AND user_id = ?`,
            ).bind(ready ? 1 : 0, this.lobbyId, attached.userId).run();
        } catch {
            // ready state is best-effort persistence — a transient DB
            // hiccup mustn't break the in-memory protocol.
        }
        this.broadcast({
            type: 'member_ready',
            user_id: attached.userId,
            ready,
        }, null);
    }

    /** 26.0.0.0/8 — the Radmin VPN range. We only accept IPs in it. */
    private static readonly RADMIN_IP_RE = /^26\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

    private handleSetRadminIp(
        attached: AttachedSocket,
        frame: { type: string } & Record<string, unknown>,
    ): void {
        const ip = typeof frame.ip === 'string' ? frame.ip.trim() : '';
        // Reject anything outside Radmin's 26.x range so a client can't inject
        // an arbitrary host for everyone to ping.
        if (!LobbyRoom.RADMIN_IP_RE.test(ip)) return;
        const existing = this.members[attached.userId];
        if (!existing) return;
        if (existing.radminIp === ip) return; // no change → no broadcast
        existing.radminIp = ip;
        this.broadcast({
            type: 'member_net',
            user_id: attached.userId,
            radmin_ip: ip,
        }, null);
    }

    private handlePeerAnnounce(
        attached: AttachedSocket,
        frame: { type: string } & Record<string, unknown>,
    ): void {
        this.broadcast({
            type: 'peer_announce',
            user_id: attached.userId,
            login: attached.discordUsername,
            endpoints: frame.endpoints ?? [],
        }, null);
    }

    private handlePeerRelay(
        attached: AttachedSocket,
        frame: { type: string } & Record<string, unknown>,
    ): void {
        const target = typeof frame.to_user === 'string' ? frame.to_user : null;
        if (!target) return;
        const payload = {
            type: 'peer_relay',
            from_user: attached.userId,
            from_login: attached.discordUsername,
            payload: frame.payload ?? null,
        };
        const json = JSON.stringify(payload);
        for (const [ws, other] of this.attached) {
            if (other.userId !== target) continue;
            if (ws.readyState !== 1 /* OPEN */) continue;
            try { ws.send(json); } catch { /* socket dying */ }
            return;
        }
    }

    private handleGameRelay(
        attached: AttachedSocket,
        frame: { type: string } & Record<string, unknown>,
    ): void {
        const target = typeof frame.to_user === 'string' ? frame.to_user : null;
        if (!target) return;
        const out = {
            type: 'game_relay',
            from_user: attached.userId,
            src_port: frame.src_port,
            dst_port: frame.dst_port,
            payload_b64: frame.payload_b64,
        };
        const json = JSON.stringify(out);
        for (const [ws, other] of this.attached) {
            if (other.userId !== target) continue;
            if (ws.readyState !== 1) continue;
            try { ws.send(json); } catch { /* socket dying */ }
            return;
        }
    }

    // 10s, matching the launcher (which floors game_countdown to 10s). The two
    // MUST agree or the abort-window math below is off by their difference.
    private static readonly COUNTDOWN_MS = 10_000;
    // Abort grace window: any member can cancel the match for everyone from the
    // moment Start is pressed until COUNTDOWN_MS + 60s — i.e. the 10s countdown
    // plus 60s after AoE3 launches (covers map load + the first moments of
    // play). After that, leaving only removes yourself.
    private static readonly ABORT_GRACE_MS = LobbyRoom.COUNTDOWN_MS + 60_000;

    private async handleStart(
        ws: WebSocket,
        ctx: AppContext,
        attached: AttachedSocket,
    ): Promise<void> {
        if (this.hostUserId !== attached.userId) {
            this.sendError(ws, 'forbidden', 'Only the host can start the game');
            return;
        }
        await ctx.db.prepare(
            `UPDATE lobbies SET status = 'in_game', started_at = datetime('now') WHERE id = ?`,
        ).bind(this.lobbyId).run();
        this.startedAtMs = Date.now();
        const startsAtMs = this.startedAtMs + LobbyRoom.COUNTDOWN_MS;
        this.broadcast({
            type: 'game_countdown',
            starts_at_ms: startsAtMs,
            duration_ms: LobbyRoom.COUNTDOWN_MS,
        }, null);
    }

    private async handleCancelGame(
        ws: WebSocket,
        ctx: AppContext,
        attached: AttachedSocket,
        frame: { reason?: string } & Record<string, unknown>,
    ): Promise<void> {
        // Abort is allowed for ANY member, but only inside the grace window
        // (server-authoritative — measured off our own Start clock, no client
        // timestamp trust). Past the window nobody aborts the match for everyone;
        // leaving only removes the leaver.
        const withinWindow =
            this.startedAtMs != null &&
            (Date.now() - this.startedAtMs) < LobbyRoom.ABORT_GRACE_MS;
        if (!withinWindow) {
            this.sendError(
                ws,
                'grace_window_closed',
                'The abort window has passed — leaving only removes you.',
            );
            return;
        }
        this.startedAtMs = null;
        await ctx.db.prepare(
            `UPDATE lobbies SET status = 'open', started_at = NULL WHERE id = ?`,
        ).bind(this.lobbyId).run();
        this.broadcast({
            type: 'game_cancelled',
            reason: typeof frame.reason === 'string' ? frame.reason : 'aborted',
            cancelled_by: attached.userId,
        }, null);
    }

    /**
     * Host kicks a member: tell the target it was kicked, then close its
     * socket. The close fires the normal `ws.on('close')` cleanup (delete the
     * row, recompute current_players, broadcast member_left), so the roster
     * updates for everyone with no extra logic. Simple kick — no ban list, the
     * target may re-join. Host-only; a non-host or a self-target is ignored.
     */
    private handleKick(
        ws: WebSocket,
        attached: AttachedSocket,
        frame: { type: string } & Record<string, unknown>,
    ): void {
        if (this.hostUserId !== attached.userId) {
            this.sendError(ws, 'forbidden', 'Only the host can kick players');
            return;
        }
        const targetId = typeof frame.user_id === 'string' ? frame.user_id : '';
        if (!targetId || targetId === attached.userId) return;
        for (const [sock, a] of this.attached) {
            if (a.userId !== targetId) continue;
            try { this.send(sock, { type: 'kicked', by: attached.userId }); } catch { /* dying */ }
            try { sock.close(4007, 'kicked'); } catch { /* already closing */ }
        }
    }

    // ---------- host migration / disconnect cleanup ---------------

    /**
     * DB bookkeeping for an abrupt socket close (the path REST /leave never
     * sees). Removes the leaver's lobby_members row and recomputes
     * current_players for ANYONE; if the leaver was the host, migrates the host
     * to the next live member, or closes the lobby if nobody's left.
     */
    private async handleDisconnectCleanup(
        ctx: AppContext,
        userId: string,
        wasHost: boolean,
    ): Promise<void> {
        try {
            await ctx.db.batch([
                ctx.db.prepare(
                    `DELETE FROM lobby_members WHERE lobby_id = ? AND user_id = ?`,
                ).bind(this.lobbyId, userId),
                ctx.db.prepare(
                    `UPDATE lobbies SET current_players = (
                        SELECT COUNT(*) FROM lobby_members WHERE lobby_id = ?
                     ) WHERE id = ?`,
                ).bind(this.lobbyId, this.lobbyId),
            ]);
        } catch {
            // Best-effort: a transient DB hiccup mustn't crash the close handler.
        }
        if (!wasHost) return;
        const migrated = await this.reassignHost(ctx, userId);
        if (!migrated) {
            try {
                await ctx.db.prepare(
                    `UPDATE lobbies SET status='closed', closed_at=datetime('now') WHERE id = ?`,
                ).bind(this.lobbyId).run();
            } catch { /* best-effort */ }
        }
    }

    /**
     * Move the host to the next member by JOIN ORDER that is still LIVE
     * (attached). Selecting from lobby_members alone would pick a "ghost" (a
     * crashed member whose row lingers because abrupt closes don't sync the DB);
     * intersecting with the live attached set guarantees the new host actually
     * has an open socket while preserving "the second who joined" order.
     * Idempotent: if the host is already someone other than the leaver, a prior
     * path (the other of REST /leave vs ws close) handled it. Returns false when
     * no live member remains (caller should close the lobby).
     */
    async reassignHost(ctx: AppContext, leavingUserId: string): Promise<boolean> {
        if (this.hostUserId !== leavingUserId) return true;
        const rows = await ctx.db.prepare(
            `SELECT user_id FROM lobby_members WHERE lobby_id = ? ORDER BY joined_at ASC`,
        ).bind(this.lobbyId).all<{ user_id: string }>();
        const live = new Set<string>();
        for (const a of this.attached.values()) live.add(a.userId);
        const next = (rows.results ?? [])
            .map((r) => r.user_id)
            .find((id) => id !== leavingUserId && live.has(id));
        if (!next) return false;
        // Commit the DB host BEFORE broadcasting, so a client that re-queries on
        // host_changed doesn't race the stale value.
        await ctx.db.prepare(
            `UPDATE lobbies SET host_user_id = ? WHERE id = ?`,
        ).bind(next, this.lobbyId).run();
        this.hostUserId = next;
        this.broadcast({
            type: 'host_changed',
            new_host_user_id: next,
            new_host_login: this.members[next]?.login ?? '',
        }, null);
        return true;
    }

    /** True when at least one socket is still attached (used by REST /leave). */
    hasLiveSockets(): boolean {
        return this.attached.size > 0;
    }

    // ---------- broadcast / send helpers --------------------------

    private broadcast(frame: object, exclude: WebSocket | null): void {
        const payload = JSON.stringify(frame);
        const now = Date.now();
        for (const [ws, attached] of this.attached) {
            if (ws === exclude) continue;
            if (ws.readyState !== 1 /* OPEN */) continue;
            try { ws.send(payload); }
            catch { this.attached.delete(ws); }
            // Idle kick: launcher pings every 30s; anything quiet
            // for 90s+ is unresponsive.
            if (now - attached.lastFrameAt > IDLE_KICK_AFTER_MS) {
                try { ws.close(4005, 'idle'); } catch { /* already closing */ }
                this.attached.delete(ws);
            }
        }
    }

    private send(ws: WebSocket, frame: object): void {
        try { ws.send(JSON.stringify(frame)); }
        catch { /* socket dying */ }
    }

    private sendError(ws: WebSocket, code: string, message: string): void {
        this.send(ws, { type: 'error', code, message });
    }
}

/**
 * In-process equivalent of the Cloudflare DO namespace. Stores one
 * <c>LobbyRoom</c> per lobby id; idempotent <c>getOrCreate</c> so the
 * REST and WS upgrade paths can both make sure a room exists before
 * routing the user to it. Garbage-collects rooms whose last socket
 * disconnects AND whose D1 row is in <c>closed</c> status (so we
 * don't lose in-flight chat just because the host briefly disconnected).
 */
export class LobbyRoomRegistry {
    private rooms = new Map<string, LobbyRoom>();

    getOrCreate(lobbyId: string, hostUserId: string): LobbyRoom {
        let room = this.rooms.get(lobbyId);
        if (!room) {
            room = new LobbyRoom(lobbyId, hostUserId);
            this.rooms.set(lobbyId, room);
        }
        return room;
    }

    get(lobbyId: string): LobbyRoom | undefined {
        return this.rooms.get(lobbyId);
    }

    /**
     * Forcibly drop a room and close all its sockets. Called from the
     * host's REST /leave path (and from match-report close) so a
     * closed lobby doesn't keep its in-memory state forever.
     */
    close(lobbyId: string, code = 4006, reason = 'lobby_closed'): void {
        const room = this.rooms.get(lobbyId);
        if (!room) return;
        for (const ws of (room as unknown as { attached: Map<WebSocket, unknown> }).attached.keys()) {
            try { ws.close(code, reason); } catch { /* */ }
        }
        this.rooms.delete(lobbyId);
    }
}

export type { LobbyRoom };
