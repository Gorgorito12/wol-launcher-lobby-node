import type { FastifyInstance } from 'fastify';
import { Errors } from '../lib/errors';
import { shortId, sha256Hex, uuid } from '../lib/ids';
import { requireAuth } from '../middleware/auth';
import { ipRateLimit, userRateLimit, Limits } from '../middleware/rateLimit';
import type { AppContext } from '../context';

interface LobbyRow {
    id: string;
    host_user_id: string;
    title: string;
    mod_id: string;
    mod_combined_hash: string;
    max_players: number;
    current_players: number;
    is_private: number;
    password_hash: string | null;
    status: 'open' | 'locked' | 'in_game' | 'closed';
    created_at: string;
}

interface CreateLobbyBody {
    title: string;
    mod_id: string;
    mod_combined_hash: string;
    max_players?: number;
    password?: string;
}

interface JoinLobbyBody {
    mod_combined_hash: string;
    password?: string;
}

/**
 * Mount /lobbies/* on the Fastify instance. Direct port of the original
 * Hono router with the same routes, same SQL, same response shapes —
 * the launcher's <c>LobbyApiClient</c> can't tell which backend it's
 * talking to.
 */
export function registerLobbiesRest(app: FastifyInstance, ctx: AppContext): void {
    // GET /lobbies — public list.
    app.get('/lobbies', {
        preHandler: [ipRateLimit(ctx, Limits.LobbyListIp)],
    }, async (_req, reply) => {
        const rows = await ctx.db.prepare(
            `SELECT l.id, l.host_user_id, l.title, l.mod_id, l.mod_combined_hash,
                    l.max_players, l.current_players, l.is_private, l.status,
                    l.created_at, u.github_login AS host_login, u.display_name AS host_name
             FROM lobbies l
             JOIN users u ON u.id = l.host_user_id
             WHERE l.status IN ('open', 'locked', 'in_game')
             ORDER BY l.created_at DESC
             LIMIT 100`,
        ).bind().all<{
            id: string;
            host_user_id: string;
            title: string;
            mod_id: string;
            mod_combined_hash: string;
            max_players: number;
            current_players: number;
            is_private: number;
            status: 'open' | 'locked' | 'in_game';
            created_at: string;
            host_login: string;
            host_name: string;
        }>();

        reply.header('Cache-Control', 'public, max-age=5');
        return reply.send({
            lobbies: (rows.results ?? []).map((r) => ({
                id: r.id,
                title: r.title,
                mod_id: r.mod_id,
                mod_combined_hash: r.mod_combined_hash,
                max_players: r.max_players,
                current_players: r.current_players,
                is_private: r.is_private === 1,
                status: r.status,
                created_at: r.created_at,
                host: {
                    id: r.host_user_id,
                    github_login: r.host_login,
                    display_name: r.host_name,
                },
            })),
        });
    });

    // POST /lobbies — create.
    app.post('/lobbies', {
        preHandler: [
            requireAuth(),
            ipRateLimit(ctx, Limits.LobbyCreateIp),
            userRateLimit(ctx, Limits.LobbyCreateUser),
        ],
    }, async (req, reply) => {
        const cfg = ctx.config;
        const userId = req.userId!;

        const body = (req.body ?? {}) as CreateLobbyBody;
        if (!body.title || !body.mod_id || !body.mod_combined_hash) {
            throw Errors.BadRequest('title, mod_id and mod_combined_hash are required');
        }
        const title = body.title.trim().slice(0, 80);
        if (title.length < 3) throw Errors.BadRequest('title too short');

        const maxPlayers = Math.min(
            cfg.lobbyMaxPlayers,
            Math.max(2, Number.isFinite(body.max_players) ? body.max_players! : cfg.lobbyMaxPlayers),
        );

        // Force-close any prior lobby this user was hosting — same
        // "create new = implicit leave previous" behaviour as the Worker.
        const stale = await ctx.db.prepare(
            `SELECT id FROM lobbies
             WHERE host_user_id = ? AND status IN ('open','locked','in_game')`,
        ).bind(userId).all<{ id: string }>();

        for (const row of stale.results ?? []) {
            await ctx.db.batch([
                ctx.db.prepare(
                    `UPDATE lobbies SET status='closed', closed_at=datetime('now') WHERE id = ?`,
                ).bind(row.id),
                ctx.db.prepare(
                    `DELETE FROM lobby_members WHERE lobby_id = ?`,
                ).bind(row.id),
            ]);
            ctx.rooms.close(row.id);
        }

        const active = await ctx.db.prepare(
            `SELECT COUNT(*) AS n FROM lobbies WHERE status IN ('open','locked','in_game')`,
        ).bind().first<{ n: number }>();
        if ((active?.n ?? 0) >= cfg.maxActiveGames) {
            throw Errors.Conflict('Server full — max concurrent lobbies reached.');
        }

        const lobbyId = shortId(8);
        const passwordHash = body.password ? await sha256Hex(body.password) : null;
        const isPrivate = passwordHash ? 1 : 0;

        await ctx.db.batch([
            ctx.db.prepare(
                `INSERT INTO lobbies (id, host_user_id, title, mod_id, mod_combined_hash,
                                      max_players, current_players, is_private, password_hash, status)
                 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'open')`,
            ).bind(
                lobbyId, userId, title, body.mod_id, body.mod_combined_hash,
                maxPlayers, isPrivate, passwordHash,
            ),
            ctx.db.prepare(
                `INSERT INTO lobby_members (lobby_id, user_id, role) VALUES (?, ?, 'player')`,
            ).bind(lobbyId, userId),
        ]);

        // Pre-create the in-memory room so the host's WS upgrade
        // doesn't race against an empty registry.
        ctx.rooms.getOrCreate(lobbyId, userId);

        return reply.code(201).send({
            id: lobbyId,
            title,
            mod_id: body.mod_id,
            mod_combined_hash: body.mod_combined_hash,
            max_players: maxPlayers,
            current_players: 1,
            is_private: isPrivate === 1,
            status: 'open',
        });
    });

    // GET /lobbies/:id — details with members.
    app.get('/lobbies/:id', {
        preHandler: [ipRateLimit(ctx, Limits.LobbyListIp)],
    }, async (req, reply) => {
        const lobbyId = (req.params as { id: string }).id;
        const lobby = await ctx.db.prepare(
            `SELECT * FROM lobbies WHERE id = ?`,
        ).bind(lobbyId).first<LobbyRow>();
        if (!lobby || lobby.status === 'closed') throw Errors.NotFound('Lobby');

        const members = await ctx.db.prepare(
            `SELECT lm.user_id, lm.is_ready, lm.role, u.github_login, u.display_name, u.avatar_url
             FROM lobby_members lm
             JOIN users u ON u.id = lm.user_id
             WHERE lm.lobby_id = ?
             ORDER BY lm.joined_at ASC`,
        ).bind(lobbyId).all<{
            user_id: string;
            is_ready: number;
            role: 'player' | 'spectator';
            github_login: string;
            display_name: string;
            avatar_url: string | null;
        }>();

        return reply.send({
            id: lobby.id,
            title: lobby.title,
            mod_id: lobby.mod_id,
            mod_combined_hash: lobby.mod_combined_hash,
            max_players: lobby.max_players,
            current_players: lobby.current_players,
            is_private: lobby.is_private === 1,
            status: lobby.status,
            host_user_id: lobby.host_user_id,
            members: (members.results ?? []).map((m) => ({
                id: m.user_id,
                github_login: m.github_login,
                display_name: m.display_name,
                avatar_url: m.avatar_url,
                is_ready: m.is_ready === 1,
                role: m.role,
            })),
        });
    });

    // POST /lobbies/:id/join — pre-join check + WS join token.
    app.post('/lobbies/:id/join', {
        preHandler: [
            requireAuth(),
            ipRateLimit(ctx, Limits.LobbyJoinIp),
            userRateLimit(ctx, Limits.LobbyJoinUser),
        ],
    }, async (req, reply) => {
        const userId = req.userId!;
        const lobbyId = (req.params as { id: string }).id;
        const body = (req.body ?? {}) as JoinLobbyBody;
        if (!body.mod_combined_hash) throw Errors.BadRequest('mod_combined_hash required');

        const lobby = await ctx.db.prepare(
            `SELECT * FROM lobbies WHERE id = ?`,
        ).bind(lobbyId).first<LobbyRow>();
        if (!lobby || lobby.status === 'closed') throw Errors.NotFound('Lobby');
        if (lobby.status === 'in_game') throw Errors.Conflict('Lobby already in game.');
        if (lobby.current_players >= lobby.max_players) throw Errors.LobbyFull();

        if (lobby.is_private === 1) {
            if (!body.password) throw Errors.Forbidden();
            const ph = await sha256Hex(body.password);
            if (ph !== lobby.password_hash) throw Errors.Forbidden();
        }

        if (lobby.mod_combined_hash !== body.mod_combined_hash) {
            throw Errors.ModMismatch({
                expected: lobby.mod_combined_hash,
                got: body.mod_combined_hash,
                mod_id: lobby.mod_id,
            });
        }

        const inOther = await ctx.db.prepare(
            `SELECT lobby_id FROM lobby_members
             WHERE user_id = ? AND lobby_id != ?
             LIMIT 1`,
        ).bind(userId, lobbyId).first();
        if (inOther) throw Errors.AlreadyInLobby();

        await ctx.db.batch([
            ctx.db.prepare(
                `INSERT INTO lobby_members (lobby_id, user_id, role)
                 VALUES (?, ?, 'player')
                 ON CONFLICT (lobby_id, user_id) DO UPDATE SET is_ready = 0`,
            ).bind(lobbyId, userId),
            ctx.db.prepare(
                `UPDATE lobbies SET current_players = (
                    SELECT COUNT(*) FROM lobby_members WHERE lobby_id = ?
                 ) WHERE id = ?`,
            ).bind(lobbyId, lobbyId),
        ]);

        const joinToken = uuid();
        await ctx.kv.put(
            `lobby:join:${joinToken}`,
            JSON.stringify({ userId, lobbyId }),
            { expirationTtl: 120 },
        );

        return reply.send({
            lobby_id: lobbyId,
            join_token: joinToken,
            ws_url: `/lobbies/${lobbyId}/ws`,
        });
    });

    // POST /lobbies/:id/leave.
    app.post('/lobbies/:id/leave', {
        preHandler: [requireAuth(), ipRateLimit(ctx, Limits.LobbyJoinIp)],
    }, async (req, reply) => {
        const userId = req.userId!;
        const lobbyId = (req.params as { id: string }).id;

        const lobby = await ctx.db.prepare(
            `SELECT * FROM lobbies WHERE id = ?`,
        ).bind(lobbyId).first<LobbyRow>();
        if (!lobby) throw Errors.NotFound('Lobby');

        const isHost = lobby.host_user_id === userId;
        if (isHost) {
            await ctx.db.batch([
                ctx.db.prepare(
                    `UPDATE lobbies SET status='closed', closed_at=datetime('now') WHERE id = ?`,
                ).bind(lobbyId),
                ctx.db.prepare(
                    `DELETE FROM lobby_members WHERE lobby_id = ?`,
                ).bind(lobbyId),
            ]);
            ctx.rooms.close(lobbyId);
        } else {
            await ctx.db.batch([
                ctx.db.prepare(
                    `DELETE FROM lobby_members WHERE lobby_id = ? AND user_id = ?`,
                ).bind(lobbyId, userId),
                ctx.db.prepare(
                    `UPDATE lobbies SET current_players = (
                        SELECT COUNT(*) FROM lobby_members WHERE lobby_id = ?
                     ) WHERE id = ?`,
                ).bind(lobbyId, lobbyId),
            ]);
        }
        return reply.send({ ok: true });
    });
}
