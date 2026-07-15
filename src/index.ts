import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { loadConfig } from './env';
import { Db } from './db';
import { KvStore } from './kv';
import { LobbyRoomRegistry, attachGlobalChat } from './lobbies/LobbyRoom';
import { GlobalChatRoom } from './global/GlobalChatRoom';
import { HttpError, Errors, apiError } from './lib/errors';
import type { AppContext } from './context';
import { readAuth, requireAuth, safeRead } from './middleware/auth';
import { circuitBreaker, readGlobalCount } from './middleware/circuitBreaker';
import { ipRateLimit, Limits } from './middleware/rateLimit';
import { registerDiscordAuth } from './auth/discord';
import { registerLobbiesRest } from './lobbies/rest';
import { configure as configureDiscordAnnounce } from './lobbies/discordAnnounce';
import { scheduleOrphanLobbySweep } from './lobbies/orphanSweep';
import { registerMatchesRest } from './matches/rest';
import { registerReplaysRest } from './replays/rest';

const SERVICE_VERSION = '0.1.0';

async function main(): Promise<void> {
    const config = loadConfig();
    mkdirSync(config.replaysDir, { recursive: true });

    // ----- Storage -----
    const db = new Db(config.dbPath);
    const migrationsDir = join(process.cwd(), 'migrations');
    const { applied } = db.migrate(migrationsDir);
    if (applied.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`[migrate] applied: ${applied.join(', ')}`);
    }
    const kv = new KvStore(db);
    kv.init();
    kv.startSweepLoop();

    // ----- App context -----
    const rooms = new LobbyRoomRegistry();
    const globalChat = new GlobalChatRoom();
    const ctx: AppContext = { config, db, kv, rooms, globalChat };
    // Let the lobby paths nudge the global players panel on room-state changes.
    attachGlobalChat(globalChat);

    // ----- Fastify -----
    const app: FastifyInstance = Fastify({
        logger: true,
        // Trust the first hop's x-forwarded-for so rate limits attribute
        // to the real client behind nginx.
        trustProxy: true,
        bodyLimit: 1 * 1024 * 1024, // 1 MB default; replays override per-route
    });

    // Share config + logger + db with the Discord room-announcement module so the
    // WS broadcast / close paths can post & edit messages without threading ctx.
    // The db is what lets it rehydrate an announcement posted by a PREVIOUS
    // process (see discordAnnounce's ensureState).
    configureDiscordAnnounce(config, app.log, db);

    // CORS — open like the Worker. The launcher is the only intended
    // client, but leaving CORS open keeps a future status page on a
    // different origin from breaking.
    await app.register(cors, {
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Authorization', 'Content-Type', 'X-Dev-User'],
        maxAge: 3600,
    });

    // @fastify/websocket adds an .ws helper to routes. We use it just
    // for the /lobbies/:id/ws upgrade — REST stays plain Fastify.
    await app.register(websocket, {
        options: {
            // Match @cloudflare/workers default-ish per-message size.
            maxPayload: 256 * 1024,
        },
    });

    // ----- Global preHandlers -----
    // Auth is parsed on every request so per-user rate limits work,
    // but nothing rejects yet — per-route requireAuth() does that.
    app.addHook('preHandler', readAuth(ctx));
    // Catch-all IP rate limit. Mounted before the circuit breaker so
    // a single abusive IP can't drain the global budget.
    app.addHook('preHandler', ipRateLimit(ctx, Limits.CatchAllIp));

    // ----- Routes that stay up in degraded mode -----

    // Deep-link bounce for the Discord "Join" link. Discord can't linkify a
    // custom scheme, so a room announcement links here (HTTPS); this returns a
    // tiny page that redirects the browser to wol-launcher://join/<id>, opening
    // the launcher and auto-joining the room. Public + no DB; the id is UNTRUSTED
    // so only a validated alphanumeric token is ever emitted into the scheme.
    app.get('/j/:id', async (req, reply) => {
        const id = String((req.params as { id?: string }).id ?? '');
        if (!/^[A-Za-z0-9]{1,32}$/.test(id)) {
            reply.code(400).type('text/plain').send('Invalid room id.');
            return;
        }
        const deep = `wol-launcher://join/${id}`;
        const deepJs = JSON.stringify(deep); // safe for the inline script
        reply.type('text/html').send(
            '<!doctype html><html><head><meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<title>Joining room…</title>' +
            `<meta http-equiv="refresh" content="0;url=${deep}">` +
            `<script>location.href=${deepJs};</script>` +
            '<style>body{font-family:system-ui,Segoe UI,sans-serif;background:#0f1a2b;' +
            'color:#e6eef8;text-align:center;padding:48px}a{color:#e0a82e}</style>' +
            '</head><body><h2>Opening the Wars of Liberty Launcher…</h2>' +
            `<p>If nothing happens, <a href="${deep}">click here</a> — ` +
            'or make sure the launcher is installed.</p></body></html>',
        );
    });

    app.get('/health', {
        preHandler: [safeRead(), circuitBreaker(ctx)],
    }, async (_req, _reply) => {
        const used = await readGlobalCount(ctx);
        return {
            ok: true,
            version: SERVICE_VERSION,
            quota: {
                used_today: used,
                soft_limit: config.dailyDegradeThreshold,
                hard_limit: config.dailyHardLimit,
                daily_budget: config.dailyRequestBudget,
            },
        };
    });

    // /quota is cheap and read-only; we don't bother edge-caching like
    // the Worker did (Cloudflare cache was per-PoP and free) because a
    // single VM serving the launcher's polling rate is plenty fast
    // hitting SQLite directly.
    app.get('/quota', {
        preHandler: [safeRead(), circuitBreaker(ctx)],
    }, async (_req, reply) => {
        const used = await readGlobalCount(ctx);
        const lobbiesRow = await db.prepare(
            `SELECT
                (SELECT COUNT(*) FROM lobbies WHERE status IN ('open','locked','in_game')) AS active_lobbies,
                (SELECT COUNT(*) FROM lobby_members lm
                    JOIN lobbies l ON l.id = lm.lobby_id
                    WHERE l.status IN ('open','locked','in_game')) AS active_players`,
        ).bind().first<{ active_lobbies: number; active_players: number }>();

        reply.header('Cache-Control', 'public, max-age=30');
        return {
            requests: {
                used_today: used,
                budget: config.dailyRequestBudget,
                soft_limit: config.dailyDegradeThreshold,
                hard_limit: config.dailyHardLimit,
            },
            lobbies: {
                active: lobbiesRow?.active_lobbies ?? 0,
                max: config.maxActiveGames,
            },
            players: {
                active: lobbiesRow?.active_players ?? 0,
                max: config.maxConcurrentUsers,
            },
        };
    });

    // ----- Routes guarded by the circuit breaker -----
    app.addHook('preHandler', circuitBreaker(ctx));

    registerDiscordAuth(app, ctx);
    registerLobbiesRest(app, ctx);
    registerMatchesRest(app, ctx);
    registerReplaysRest(app, ctx);

    // /me — current user + ELO snapshot. Requires auth.
    app.get('/me', { preHandler: [requireAuth()] }, async (req, _reply) => {
        const u = await db.prepare(
            `SELECT u.id, u.discord_username, u.display_name, u.avatar_url, u.created_at,
                    e.rating, e.rd, e.games_played
             FROM users u
             LEFT JOIN elo_ratings e ON e.user_id = u.id AND e.mode = 'default'
             WHERE u.id = ?`,
        ).bind(req.userId!).first();
        if (!u) throw Errors.NotFound('User');
        return u;
    });

    // ----- WebSocket: per-lobby room -----
    //
    // The launcher hits ws(s)://host/lobbies/:id/ws. We look the
    // lobby up to verify it exists and isn't closed, then hand the
    // raw socket to the in-process LobbyRoom for this id. Auth (via
    // join_token or JWT) is performed by the room on the first
    // 'hello' frame — same protocol as the Worker.
    app.get('/lobbies/:id/ws', { websocket: true }, async (socket, req) => {
        const lobbyId = (req.params as { id: string }).id;

        const lobby = await db.prepare(
            `SELECT host_user_id, status FROM lobbies WHERE id = ?`,
        ).bind(lobbyId).first<{ host_user_id: string; status: string }>();

        if (!lobby || lobby.status === 'closed') {
            try { socket.close(4404, 'lobby_not_found'); } catch { /* */ }
            return;
        }

        const room = rooms.getOrCreate(lobbyId, lobby.host_user_id);
        room.handleConnection(socket, ctx);
    });

    // ----- WebSocket: process-wide global chat -----
    //
    // One shared room for every signed-in launcher. Unlike the lobby
    // socket there's no id and no DB lookup — the room authenticates the
    // JWT on the first `hello` frame and enforces capacity / one-per-user
    // itself (see GlobalChatRoom). WS frames don't go through the per-
    // request budget, so the channel is essentially free past the upgrade.
    app.get('/global/ws', { websocket: true }, async (socket, _req) => {
        globalChat.handleConnection(socket, ctx);
    });

    // ----- Error envelope -----
    app.setErrorHandler((err: Error, _req: FastifyRequest, reply: FastifyReply) => {
        if (err instanceof HttpError) {
            reply
                .code(err.status)
                .type('application/json')
                .send(apiError(err.code, err.message, err.details));
            return;
        }
        app.log.error(err);
        reply
            .code(500)
            .type('application/json')
            .send(apiError('internal', 'Unexpected server error.'));
    });

    app.setNotFoundHandler((_req: FastifyRequest, reply: FastifyReply) => {
        reply
            .code(404)
            .type('application/json')
            .send(apiError('not_found', 'Route not found.'));
    });

    // ----- Listen -----
    try {
        await app.listen({ host: config.host, port: config.port });
    } catch (err) {
        app.log.error(err);
        process.exit(1);
    }

    // ----- Reap lobbies left behind by the previous process -----
    // After the grace window, so rooms whose players reconnect survive.
    const orphanSweep = scheduleOrphanLobbySweep(ctx, app.log);

    // ----- Graceful shutdown -----
    const shutdown = async (signal: string): Promise<void> => {
        app.log.info(`Received ${signal}, shutting down...`);
        try { clearTimeout(orphanSweep); } catch { /* ignore */ }
        try { await app.close(); } catch { /* ignore */ }
        try { kv.stopSweepLoop(); } catch { /* ignore */ }
        try { db.close(); } catch { /* ignore */ }
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Fatal startup error:', err);
    process.exit(1);
});
