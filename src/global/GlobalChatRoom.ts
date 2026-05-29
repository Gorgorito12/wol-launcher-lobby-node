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
    /** Last frame timestamp, used for idle-kick. */
    lastFrameAt: number;
    /** Counts chat frames inside the current minute window for throttling. */
    chatWindowStart: number;
    chatWindowCount: number;
}

interface ChatLine {
    id: string;
    userId: string;
    login: string;
    body: string;
    at: number;
}

const IDLE_KICK_AFTER_MS = 90 * 1000;
const MAX_CHAT_LEN = 500;

export class GlobalChatRoom {
    private chatRing: ChatLine[] = [];
    private attached = new Map<WebSocket, AttachedSocket>();

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
            if (attached) this.broadcastPresence();
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
            lastFrameAt: now,
            chatWindowStart: now,
            chatWindowCount: 0,
        });

        // Hand the joiner the recent history + current presence in one
        // frame, then tell everyone the count ticked up.
        this.send(ws, {
            type: 'global_state',
            history: this.chatRing,
            online: this.attached.size,
        });
        this.broadcastPresence();
    }

    private handleChat(
        ws: WebSocket,
        ctx: AppContext,
        attached: AttachedSocket,
        frame: { type: string } & Record<string, unknown>,
    ): void {
        const body = typeof frame.body === 'string' ? frame.body.trim() : '';
        if (!body) return;
        if (body.length > MAX_CHAT_LEN) {
            this.sendError(ws, 'chat_too_long', `Max ${MAX_CHAT_LEN} chars per message`);
            return;
        }

        const now = Date.now();
        if (now - attached.chatWindowStart > 60_000) {
            attached.chatWindowStart = now;
            attached.chatWindowCount = 0;
        }
        attached.chatWindowCount += 1;
        if (attached.chatWindowCount > ctx.config.globalChatMsgsPerMin) {
            this.sendError(ws, 'chat_rate_limited', 'Slow down — global chat throttled');
            return;
        }

        const line: ChatLine = {
            id: randomUUID(),
            userId: attached.userId,
            login: attached.login,
            body,
            at: now,
        };
        this.chatRing.push(line);
        const max = ctx.config.globalChatHistory;
        while (this.chatRing.length > max) this.chatRing.shift();
        this.broadcast({ type: 'chat', line }, null);
    }

    // ---------- broadcast / send helpers --------------------------

    private broadcastPresence(): void {
        this.broadcast({ type: 'presence', online: this.attached.size }, null);
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
