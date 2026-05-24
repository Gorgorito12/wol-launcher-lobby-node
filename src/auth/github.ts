import type { FastifyInstance } from 'fastify';
import { fetch } from 'undici';
import { Errors } from '../lib/errors.js';
import { mintSession } from '../lib/jwt.js';
import { uuid } from '../lib/ids.js';
import { ipRateLimit, Limits } from '../middleware/rateLimit.js';
import type { AppContext } from '../context.js';

/**
 * GitHub OAuth — Device Flow.
 *
 * Why device flow and not authorization code?
 *   * The launcher is a desktop WPF app — no redirect URI to register,
 *     no embedded webview, no localhost dance with a random port. The
 *     user authorises in their normal browser and the launcher polls
 *     for completion.
 *   * The client secret stays on the backend; the launcher only has the
 *     client id (public). GitHub's device endpoint accepts both, but
 *     requires the secret to be present for confidential apps. Keeping
 *     the secret server-side keeps it out of every end-user binary.
 *
 * Migrated from the Worker version with two changes only:
 *   * <c>fetch</c> comes from <c>undici</c> (Node's built-in fetch is
 *     fine on 18+ but undici gives consistent error semantics).
 *   * KV calls go through our SQLite-backed <c>KvStore</c>. The keys
 *     and TTLs are unchanged so a in-flight device code from the old
 *     Worker doesn't need to be re-issued.
 */

const POLL_HANDLE_TTL_SECONDS = 15 * 60; // matches GitHub's device_code TTL

interface DeviceCodeResponse {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
}

interface AccessTokenSuccess {
    access_token: string;
    token_type: string;
    scope: string;
}

interface AccessTokenPending {
    error: string;
    error_description?: string;
}

type AccessTokenResponse = AccessTokenSuccess | AccessTokenPending;

interface GithubUser {
    id: number;
    login: string;
    avatar_url?: string;
    name?: string | null;
}

/**
 * Mounts /auth/github/{device,poll} on the given Fastify instance.
 * Wired in <c>index.ts</c> behind the same rate-limit chain the Worker
 * used (5/min for device, 60/min for poll).
 */
export function registerGithubAuth(app: FastifyInstance, ctx: AppContext): void {
    app.post('/auth/github/device', {
        preHandler: [ipRateLimit(ctx, Limits.AuthDeviceIp)],
    }, async (req, reply) => {
        if (ctx.config.devAuthBypass) {
            return reply.send({
                user_code: 'DEV-LOCAL',
                verification_uri: `http://${ctx.config.host}:${ctx.config.port}/dev/info`,
                interval: 5,
                expires_in: 900,
                poll_handle: 'dev-handle',
            });
        }

        const body = new URLSearchParams({
            client_id: ctx.config.githubClientId,
            scope: 'read:user',
        });
        const resp = await fetch('https://github.com/login/device/code', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'wol-launcher-lobby-node',
            },
            body,
        });
        if (!resp.ok) throw Errors.Internal(`GitHub device endpoint returned ${resp.status}`);
        const data = (await resp.json()) as DeviceCodeResponse;

        const pollHandle = uuid();
        await ctx.kv.put(
            `oauth:device:${pollHandle}`,
            JSON.stringify({ device_code: data.device_code }),
            { expirationTtl: Math.min(POLL_HANDLE_TTL_SECONDS, data.expires_in || POLL_HANDLE_TTL_SECONDS) },
        );

        return reply.send({
            user_code: data.user_code,
            verification_uri: data.verification_uri,
            interval: Math.max(5, data.interval || 5),
            expires_in: data.expires_in,
            poll_handle: pollHandle,
        });
    });

    app.post('/auth/github/poll', {
        preHandler: [ipRateLimit(ctx, Limits.AuthPollIp)],
    }, async (req, reply) => {
        const cfg = ctx.config;

        if (cfg.devAuthBypass) {
            const userId = 'dev-user-00000001';
            const login = 'dev-user';
            await ctx.db.batch([
                ctx.db.prepare(
                    `INSERT INTO users (id, github_id, github_login, display_name, avatar_url)
                     VALUES (?, ?, ?, ?, NULL)
                     ON CONFLICT (github_id) DO UPDATE SET
                       github_login = excluded.github_login,
                       last_seen_at = datetime('now')`,
                ).bind(userId, 1, login, 'Dev User'),
                ctx.db.prepare(
                    `INSERT OR IGNORE INTO elo_ratings (user_id, mode) VALUES (?, 'default')`,
                ).bind(userId),
            ]);
            const { token, expiresAt } = await mintSession(userId, login, cfg.jwtSigningKey);
            return reply.send({
                status: 'ok',
                token,
                expires_at: expiresAt,
                user: {
                    id: userId,
                    github_login: login,
                    display_name: 'Dev User',
                    avatar_url: null,
                },
                config: serverConfigPayload(cfg),
            });
        }

        const payload = (req.body ?? {}) as { poll_handle?: string };
        if (!payload.poll_handle) throw Errors.BadRequest('poll_handle required');

        const stored = await ctx.kv.get(`oauth:device:${payload.poll_handle}`);
        if (!stored) throw Errors.NotFound('Poll handle');
        const { device_code } = JSON.parse(stored) as { device_code: string };

        const body = new URLSearchParams({
            client_id: cfg.githubClientId,
            client_secret: cfg.githubClientSecret,
            device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        const resp = await fetch('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'wol-launcher-lobby-node',
            },
            body,
        });
        if (!resp.ok) throw Errors.Internal(`GitHub token endpoint returned ${resp.status}`);
        const data = (await resp.json()) as AccessTokenResponse;

        if ('error' in data) {
            if (data.error === 'authorization_pending' || data.error === 'slow_down') {
                return reply.code(202).send({ status: data.error });
            }
            if (data.error === 'expired_token') {
                await ctx.kv.delete(`oauth:device:${payload.poll_handle}`);
                throw Errors.BadRequest('Device code expired, restart authentication.');
            }
            if (data.error === 'access_denied') {
                await ctx.kv.delete(`oauth:device:${payload.poll_handle}`);
                throw Errors.Forbidden();
            }
            throw Errors.Internal(`GitHub OAuth error: ${data.error}`);
        }

        const ghResp = await fetch('https://api.github.com/user', {
            headers: {
                'Authorization': `Bearer ${data.access_token}`,
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'wol-launcher-lobby-node',
                'X-GitHub-Api-Version': '2022-11-28',
            },
        });
        if (!ghResp.ok) throw Errors.Internal(`GitHub /user returned ${ghResp.status}`);
        const gh = (await ghResp.json()) as GithubUser;

        const existing = await ctx.db.prepare(
            'SELECT id, github_login, display_name, avatar_url, is_banned FROM users WHERE github_id = ?',
        ).bind(gh.id).first<{
            id: string;
            github_login: string;
            display_name: string;
            avatar_url: string | null;
            is_banned: number;
        }>();

        let effectiveUserId: string;
        let effectiveLogin: string;
        let displayName: string;
        let avatarUrl: string | null;

        if (existing) {
            effectiveUserId = existing.id;
            effectiveLogin = gh.login;
            displayName = existing.display_name;
            avatarUrl = gh.avatar_url ?? existing.avatar_url;
            if (existing.is_banned === 1) throw Errors.UserBanned();
            await ctx.db.prepare(
                `UPDATE users SET github_login = ?, avatar_url = ?, last_seen_at = datetime('now') WHERE id = ?`,
            ).bind(effectiveLogin, avatarUrl, effectiveUserId).run();
        } else {
            effectiveUserId = uuid();
            effectiveLogin = gh.login;
            displayName = gh.name || gh.login;
            avatarUrl = gh.avatar_url ?? null;
            await ctx.db.batch([
                ctx.db.prepare(
                    `INSERT INTO users (id, github_id, github_login, display_name, avatar_url)
                     VALUES (?, ?, ?, ?, ?)`,
                ).bind(effectiveUserId, gh.id, effectiveLogin, displayName, avatarUrl),
                ctx.db.prepare(
                    `INSERT INTO elo_ratings (user_id, mode) VALUES (?, 'default')`,
                ).bind(effectiveUserId),
            ]);
        }

        await ctx.kv.delete(`oauth:device:${payload.poll_handle}`);

        const { token, expiresAt } = await mintSession(effectiveUserId, effectiveLogin, cfg.jwtSigningKey);
        return reply.send({
            status: 'ok',
            token,
            expires_at: expiresAt,
            user: {
                id: effectiveUserId,
                github_login: effectiveLogin,
                display_name: displayName,
                avatar_url: avatarUrl,
            },
            config: serverConfigPayload(cfg),
        });
    });
}

function serverConfigPayload(cfg: { maxConcurrentUsers: number; maxActiveGames: number; lobbyMaxPlayers: number; chatMsgsPerMin: number }) {
    return {
        max_concurrent_users: cfg.maxConcurrentUsers,
        max_active_games: cfg.maxActiveGames,
        lobby_max_players: cfg.lobbyMaxPlayers,
        chat_msgs_per_min: cfg.chatMsgsPerMin,
    };
}
