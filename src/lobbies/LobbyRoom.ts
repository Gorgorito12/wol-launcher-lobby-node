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
    githubLogin: string;
    /** Last frame timestamp, used for idle-kick. */
    lastFrameAt: number;
    /** Counts chat frames inside the current minute window for per-user throttling. */
    chatWindowStart: number;
    chatWindowCount: number;
}

interface MemberEntry {
    ready: boolean;
    login: string;
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
    readonly hostUserId: string;
    members: Record<string, MemberEntry> = {};
    chatRing: ChatLine[] = [];
    private attached = new Map<WebSocket, AttachedSocket>();

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
            if (this.members[attached.userId]) {
                delete this.members[attached.userId];
            }
            this.broadcast({ type: 'member_left', user_id: attached.userId }, ws);
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
                `SELECT github_login FROM users WHERE id = ?`,
            ).bind(userId).first<{ github_login: string }>();
            login = u?.github_login ?? '';
        } else if (typeof frame.token === 'string') {
            const payload = await verifyJwt(frame.token, ctx.config.jwtSigningKey);
            if (!payload) {
                this.sendError(ws, 'invalid_token', 'JWT invalid');
                ws.close(4003, 'invalid_token');
                return;
            }
            userId = payload.sub;
            login = payload.gh;
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
            githubLogin: login,
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
            github_login: login,
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
            login: attached.githubLogin,
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
            login: existing?.login ?? attached.githubLogin,
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

    private handlePeerAnnounce(
        attached: AttachedSocket,
        frame: { type: string } & Record<string, unknown>,
    ): void {
        this.broadcast({
            type: 'peer_announce',
            user_id: attached.userId,
            login: attached.githubLogin,
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
            from_login: attached.githubLogin,
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

    private static readonly COUNTDOWN_MS = 3000;

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
        const startsAtMs = Date.now() + LobbyRoom.COUNTDOWN_MS;
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
        if (this.hostUserId !== attached.userId) {
            this.sendError(ws, 'forbidden', 'Only the host can cancel the game');
            return;
        }
        await ctx.db.prepare(
            `UPDATE lobbies SET status = 'open', started_at = NULL WHERE id = ?`,
        ).bind(this.lobbyId).run();
        this.broadcast({
            type: 'game_cancelled',
            reason: typeof frame.reason === 'string' ? frame.reason : 'host_cancelled',
            cancelled_by: attached.userId,
        }, null);
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
