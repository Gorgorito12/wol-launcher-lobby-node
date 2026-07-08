import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { verifyJwt } from '../lib/jwt';
import type { AppContext } from '../context';

/**
 * Process-wide GLOBAL chat room — a single instance for the whole
 * service, in contrast to the per-lobby <c>LobbyRoom</c>. Any signed-in
 * launcher that opens <c>/global/ws</c> and sends a valid <c>hello</c>
 * (JWT) joins the shared channel, sees every connected player's messages,
 * and gets a live presence count.
 *
 * Deliberately lighter than <c>LobbyRoom</c> and bounded on every axis so
 * it stays cheap on the 1 GB VM (single-digit MB total):
 *   * No DB — membership IS "holds a valid JWT". History is a capped
 *     in-memory ring (lost on restart, by design).
 *   * One socket per user: a second <c>hello</c> for the same user id
 *     closes the older socket, so a client can't multiply its memory
 *     footprint or inflate the presence count.
 *   * Hard capacity cap (<c>config.globalChatMaxConnections</c>) so the
 *     room can never hold more sockets than the service is sized for.
 *   * Per-user send throttle (<c>config.globalChatMsgsPerMin</c>) + a
 *     500-char cap, reusing the <c>LobbyRoom</c> anti-flood approach.
 *
 * Wire protocol (JSON frames):
 *   client → server : hello {token}, chat {body}, ping
 *   server → client : global_state {history, online}, chat {line},
 *                     presence {online}, error {code, message}, pong
 */

interface AttachedSocket {
    userId: string;
    login: string;
    avatarUrl: string | null;
    /** Last frame timestamp, used for idle-kick. */
    lastFrameAt: number;
    /** Counts chat frames inside the current minute window for throttling. */
    chatWindowStart: number;
    chatWindowCount: number;
    /** Timestamp of the last accepted chat message, for slow-mode. */
    lastChatAt: number;
    /** Anti-spam strikes inside the current minute (slow-mode / rate trips). */
    strikes: number;
    strikeWindowStart: number;
}

interface ChatLine {
    id: string;
    userId: string;
    login: string;
    avatarUrl: string | null;
    body: string;
    at: number;
}

const IDLE_KICK_AFTER_MS = 90 * 1000;
const MAX_CHAT_LEN = 500;

export class GlobalChatRoom {
    private chatRing: ChatLine[] = [];
    private attached = new Map<WebSocket, AttachedSocket>();
    /** userId → epoch ms the auto-mute lifts. Keyed by user (not socket) so
     * reconnecting can't shed an active timeout. Entries are pruned lazily
     * when checked after expiry. */
    private mutedUntilByUser = new Map<string, number>();

    /** The shared AppContext (singleton), stashed on the first connection so
     * broadcastPresence / refreshPlayers can query the DB for each connected
     * user's live room status. */
    private ctx: AppContext | null = null;

    /** Debounce timer for refreshPlayers() so a burst of lobby state changes
     * collapses into one presence rebroadcast. */
    private playersRefreshTimer: ReturnType<typeof setTimeout> | null = null;

    /** Live count of authenticated sockets — the presence number. */
    get onlineCount(): number {
        return this.attached.size;
    }

    /**
     * Wire an incoming WebSocket into the global room. Same listen-for-
     * message/close/error shape as <c>LobbyRoom.handleConnection</c>;
     * auth happens lazily on the first <c>hello</c> frame.
     */
    handleConnection(ws: WebSocket, ctx: AppContext): void {
        this.ctx = ctx; // singleton AppContext; stash for DB-backed presence
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
            // Only re-broadcast presence if this socket had actually
            // joined (passed hello) — an unauthenticated socket closing
            // never changed the count.
            if (attached) void this.broadcastPresence();
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
                this.handleChat(ws, ctx, attached, f);
                break;
            case 'ping':
                this.send(ws, { type: 'pong' });
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
        const token = typeof frame.token === 'string' ? frame.token : null;
        if (!token) {
            this.sendError(ws, 'unauthenticated', 'hello frame needs a token');
            ws.close(4001, 'unauthenticated');
            return;
        }

        const payload = await verifyJwt(token, ctx.config.jwtSigningKey);
        if (!payload) {
            this.sendError(ws, 'invalid_token', 'JWT invalid');
            ws.close(4003, 'invalid_token');
            return;
        }
        const userId = payload.sub;
        const login = payload.du ?? '';

        // The JWT carries no avatar, so do ONE cheap indexed read here (per
        // connection, not per message) to show real Discord avatars in chat.
        // Cosmetic — a DB hiccup mustn't block joining the chat.
        let avatarUrl: string | null = null;
        try {
            const u = await ctx.db.prepare(
                `SELECT avatar_url FROM users WHERE id = ?`,
            ).bind(userId).first<{ avatar_url: string | null }>();
            avatarUrl = u?.avatar_url ?? null;
        } catch { /* leave null → client falls back to the monogram */ }

        // One socket per user: drop any previous socket this user holds so
        // they can't multiply connections or double-count presence. Done
        // BEFORE the capacity check so a reconnect (which frees the old
        // slot) never bounces off a full room.
        for (const [otherWs, other] of this.attached) {
            if (other.userId === userId && otherWs !== ws) {
                try { otherWs.close(4007, 'replaced'); } catch { /* already closing */ }
                this.attached.delete(otherWs);
            }
        }

        // Capacity cap — refuse a genuinely new user past the budget.
        if (this.attached.size >= ctx.config.globalChatMaxConnections) {
            this.sendError(ws, 'global_full', 'Global chat is at capacity');
            ws.close(4008, 'global_full');
            return;
        }

        const now = Date.now();
        this.attached.set(ws, {
            userId,
            login,
            avatarUrl,
            lastFrameAt: now,
            chatWindowStart: now,
            chatWindowCount: 0,
            lastChatAt: 0,
            strikes: 0,
            strikeWindowStart: now,
        });

        // Hand the joiner the recent history + current presence in one
        // frame, then tell everyone the count ticked up.
        this.send(ws, {
            type: 'global_state',
            history: this.chatRing,
            online: this.attached.size,
            onlineUsers: await this.onlineUsers(),
        });
        await this.broadcastPresence();
    }

    private handleChat(
        ws: WebSocket,
        ctx: AppContext,
        attached: AttachedSocket,
        frame: { type: string } & Record<string, unknown>,
    ): void {
        const now = Date.now();

        // Auto-timeout: while muted, every message is dropped with the
        // remaining seconds. Keyed by USER id so a reconnect can't shed it.
        // No new strike here — already punished.
        const mutedUntil = this.mutedUntilByUser.get(attached.userId) ?? 0;
        if (mutedUntil > now) {
            const secs = Math.ceil((mutedUntil - now) / 1000);
            this.sendError(ws, 'chat_muted', `Muted ${secs}s`);
            return;
        }
        if (mutedUntil !== 0) this.mutedUntilByUser.delete(attached.userId);   // expired — prune

        const body = typeof frame.body === 'string' ? frame.body.trim() : '';
        if (!body) return;
        if (body.length > MAX_CHAT_LEN) {
            this.sendError(ws, 'chat_too_long', `Max ${MAX_CHAT_LEN} chars per message`);
            return;
        }

        // Slow mode: enforce a minimum gap between messages. A violation is
        // a strike (and drops the message) but is NOT counted toward the
        // per-minute cap below — we bail before incrementing it.
        if (now - attached.lastChatAt < ctx.config.globalChatMinIntervalMs) {
            this.registerViolation(ws, ctx, attached, now, 'chat_slow_mode', 'Slow down between messages');
            return;
        }

        // Per-minute cap (sliding window).
        if (now - attached.chatWindowStart > 60_000) {
            attached.chatWindowStart = now;
            attached.chatWindowCount = 0;
        }
        attached.chatWindowCount += 1;
        if (attached.chatWindowCount > ctx.config.globalChatMsgsPerMin) {
            this.registerViolation(ws, ctx, attached, now, 'chat_rate_limited', 'Too many messages — slow down');
            return;
        }

        attached.lastChatAt = now;
        const line: ChatLine = {
            id: randomUUID(),
            userId: attached.userId,
            login: attached.login,
            avatarUrl: attached.avatarUrl,
            body,
            at: now,
        };
        this.chatRing.push(line);
        const max = ctx.config.globalChatHistory;
        while (this.chatRing.length > max) this.chatRing.shift();
        this.broadcast({ type: 'chat', line }, null);
    }

    /**
     * Count an anti-spam violation (slow-mode or per-minute trip). Strikes
     * accumulate inside a rolling minute; cross <c>globalChatTimeoutStrikes</c>
     * and the user is auto-muted for <c>globalChatTimeoutMs</c>. Otherwise we
     * just surface the specific reason so the client can show a hint.
     */
    private registerViolation(
        ws: WebSocket,
        ctx: AppContext,
        attached: AttachedSocket,
        now: number,
        code: string,
        message: string,
    ): void {
        if (now - attached.strikeWindowStart > 60_000) {
            attached.strikeWindowStart = now;
            attached.strikes = 0;
        }
        attached.strikes += 1;
        if (attached.strikes >= ctx.config.globalChatTimeoutStrikes) {
            this.mutedUntilByUser.set(attached.userId, now + ctx.config.globalChatTimeoutMs);
            attached.strikes = 0;
            const secs = Math.ceil(ctx.config.globalChatTimeoutMs / 1000);
            this.sendError(ws, 'chat_timeout', `Muted ${secs}s for spamming`);
        } else {
            this.sendError(ws, code, message);
        }
    }

    // ---------- broadcast / send helpers --------------------------

    private async broadcastPresence(): Promise<void> {
        this.broadcast(
            { type: 'presence', online: this.attached.size, onlineUsers: await this.onlineUsers() },
            null,
        );
    }

    /**
     * Rebroadcast presence (which now carries each player's live room status)
     * to everyone. The lobby paths call this whenever a room's membership or
     * status changes, so the launcher's players panel updates live. Debounced
     * (~1.5s) so a burst of lobby events is ONE rebroadcast, and best-effort
     * (never throws into the lobby flow).
     */
    refreshPlayers(): void {
        if (this.playersRefreshTimer) return;
        this.playersRefreshTimer = setTimeout(() => {
            this.playersRefreshTimer = null;
            void this.broadcastPresence().catch(() => { /* swallow */ });
        }, 1500);
    }

    /**
     * The connected users' public identities PLUS each one's live room status,
     * for the client's players panel. `login`/`avatarUrl` come from the cached
     * `attached` entries (no per-user DB read); the status comes from ONE bounded
     * query over active lobbies (≤ maxActiveGames × lobbyMaxPlayers rows, on the
     * indexed `lobby_members(user_id)` + `lobbies` PK). `in_game` → in a match,
     * `open`/`locked` → in a room/waiting, absent → `idle` (in the launcher).
     * Sent ALONGSIDE the `online` count so old clients that read only the count
     * still work; an old client also just ignores the `status` field.
     */
    private async onlineUsers():
        Promise<{ userId: string; login: string; avatarUrl: string | null; status: string }[]> {
        const statusByUser = new Map<string, string>();
        try {
            if (this.ctx) {
                const rows = await this.ctx.db
                    .prepare(
                        `SELECT lm.user_id AS userId, l.status AS status
                         FROM lobby_members lm JOIN lobbies l ON l.id = lm.lobby_id
                         WHERE l.status IN ('open','locked','in_game')`,
                    )
                    .bind()
                    .all<{ userId: string; status: string }>();
                for (const r of rows.results) {
                    statusByUser.set(r.userId, r.status === 'in_game' ? 'in_game' : 'in_room');
                }
            }
        } catch {
            // Best-effort: on a query failure everyone falls back to 'idle'
            // (still listed, just uncategorised).
        }
        const out: { userId: string; login: string; avatarUrl: string | null; status: string }[] = [];
        for (const a of this.attached.values()) {
            out.push({
                userId: a.userId,
                login: a.login,
                avatarUrl: a.avatarUrl,
                status: statusByUser.get(a.userId) ?? 'idle',
            });
        }
        return out;
    }

    private broadcast(frame: object, exclude: WebSocket | null): void {
        const payload = JSON.stringify(frame);
        const now = Date.now();
        for (const [ws, attached] of this.attached) {
            if (ws === exclude) continue;
            if (ws.readyState !== 1 /* OPEN */) continue;
            try { ws.send(payload); }
            catch { this.attached.delete(ws); }
            // Idle kick: the launcher pings every 30 s, so anything quiet
            // for 90 s+ is a dead socket the OS hasn't reaped yet.
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
