import type { FastifyInstance } from 'fastify';
import { fetch } from 'undici';
import { Errors } from '../lib/errors';
import { mintSession } from '../lib/jwt';
import { uuid } from '../lib/ids';
import { ipRateLimit, Limits } from '../middleware/rateLimit';
import type { AppContext } from '../context';

/**
 * Discord OAuth, exposed to the launcher with the same device-flow-shaped
 * API the original GitHub backend used. Discord doesn't have an official
 * device flow, but we simulate one with state-keyed polling:
 *
 *   1. Launcher  → POST /auth/login/device
 *      Backend mints a `state` (UUID), stores `pending` marker in KV
 *      under that state, returns:
 *        - verification_uri = full discord.com OAuth URL with our
 *          client_id, redirect_uri pointing at /auth/login/callback,
 *          response_type=code, scope=identify, and the state.
 *        - poll_handle = the state UUID.
 *
 *   2. Launcher opens verification_uri in the user's browser.
 *      The user clicks "Authorize" on Discord. Discord 302s to:
 *        GET /auth/login/callback?code=XYZ&state=<UUID>
 *
 *   3. Backend's /callback exchanges the code for a Discord access
 *      token, fetches the Discord user profile, UPSERTs into our
 *      users table, and stores the success payload in KV under
 *      `discord:auth-result:<state>`. The handler returns a small
 *      HTML "Done — return to the launcher" page.
 *
 *   4. Launcher  → POST /auth/login/poll { poll_handle: <UUID> }
 *      Backend reads `discord:auth-result:<state>`, deletes it
 *      single-use, and returns the JWT + user + config. Same
 *      response shape the launcher already understands from the
 *      old GitHub /poll endpoint.
 *
 * Net effect: zero protocol surprises for the launcher — the only
 * thing that changes is what the user sees in their browser
 * (Discord's branded "Authorize wol-launcher" screen instead of
 * GitHub's device-code form). And since Discord skips the
 * type-this-code-into-the-browser step, the UX is one click
 * smoother than the GitHub flow it replaces.
 */

const STATE_TTL_SECONDS = 15 * 60;     // mirror GitHub device_code TTL
const RESULT_TTL_SECONDS = 5 * 60;     // launcher polls every ~5 s; 5 min is generous

interface DiscordTokenResponse {
    access_token?: string;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
}

interface DiscordUser {
    id: string;            // snowflake (string because >53 bits)
    username: string;
    global_name?: string | null;
    avatar?: string | null;
    discriminator?: string;
}

interface AuthResult {
    userId: string;
    discordId: string;
    discordUsername: string;
    displayName: string;
    avatarUrl: string | null;
}

/**
 * Mounts /auth/login/device + /poll + /callback on the Fastify app.
 * The path is provider-agnostic ("login" not "discord") so a future
 * provider swap doesn't churn the launcher again.
 */
export function registerDiscordAuth(app: FastifyInstance, ctx: AppContext): void {
    // POST /auth/login/device — kick off the flow, return the URL to open.
    app.post('/auth/login/device', {
        preHandler: [ipRateLimit(ctx, Limits.AuthDeviceIp)],
    }, async (req, reply) => {
        const cfg = ctx.config;

        if (cfg.devAuthBypass) {
            // Synthesise a fake flow that resolves instantly on poll —
            // lets local-dev runs exercise the sign-in UI without
            // creating a Discord application.
            return reply.send({
                user_code: '',
                verification_uri: `${cfg.publicBaseUrl}/dev/info`,
                interval: 5,
                expires_in: STATE_TTL_SECONDS,
                poll_handle: 'dev-handle',
            });
        }

        if (!cfg.discordClientId || !cfg.publicBaseUrl) {
            throw Errors.Internal('Discord OAuth not configured (DISCORD_CLIENT_ID / PUBLIC_BASE_URL missing)');
        }

        const state = uuid();
        await ctx.kv.put(
            `discord:auth-state:${state}`,
            JSON.stringify({ createdAt: Date.now() }),
            { expirationTtl: STATE_TTL_SECONDS },
        );

        const redirectUri = `${cfg.publicBaseUrl}/auth/login/callback`;
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: cfg.discordClientId,
            scope: 'identify',
            state,
            redirect_uri: redirectUri,
            prompt: 'none',  // skip Discord's "you already authorized" confirmation when possible
        });
        const verificationUri = `https://discord.com/oauth2/authorize?${params.toString()}`;

        return reply.send({
            // user_code is empty because Discord's flow doesn't require
            // the user to type anything into the browser — clicking
            // "Authorize" is the whole interaction. The launcher's UI
            // hides the code line when this is empty.
            user_code: '',
            verification_uri: verificationUri,
            interval: 5,
            expires_in: STATE_TTL_SECONDS,
            poll_handle: state,
        });
    });

    // GET /auth/login/callback — Discord redirects here after the user authorises.
    // We exchange the code for a token, fetch the user, store the result
    // keyed by state, and render a "done" page.
    app.get('/auth/login/callback', async (req, reply) => {
        const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };

        if (q.error) {
            // User clicked Cancel, or Discord rejected the app.
            return reply
                .type('text/html; charset=utf-8')
                .send(htmlPage(
                    'Authorization cancelled',
                    `<p>Discord reported: <code>${escapeHtml(q.error)}</code></p>` +
                    (q.error_description
                        ? `<p>${escapeHtml(q.error_description)}</p>`
                        : '') +
                    `<p>You can close this tab and try again from the launcher.</p>`,
                ));
        }

        if (!q.code || !q.state) {
            return reply
                .code(400)
                .type('text/html; charset=utf-8')
                .send(htmlPage('Missing parameters', '<p>Both <code>code</code> and <code>state</code> are required.</p>'));
        }

        const stateRow = await ctx.kv.get(`discord:auth-state:${q.state}`);
        if (!stateRow) {
            return reply
                .code(400)
                .type('text/html; charset=utf-8')
                .send(htmlPage('State expired or unknown', '<p>The login session timed out. Try again from the launcher.</p>'));
        }

        const cfg = ctx.config;
        const tokenBody = new URLSearchParams({
            client_id: cfg.discordClientId,
            client_secret: cfg.discordClientSecret,
            grant_type: 'authorization_code',
            code: q.code,
            redirect_uri: `${cfg.publicBaseUrl}/auth/login/callback`,
        });
        const tokenResp = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'User-Agent': 'wol-launcher-lobby-node',
            },
            body: tokenBody,
        });

        if (!tokenResp.ok) {
            // Don't leak the upstream error to the user's browser, but
            // log it server-side so an operator can debug.
            const txt = await tokenResp.text().catch(() => '');
            app.log.error({ status: tokenResp.status, body: txt }, 'Discord token exchange failed');
            return reply
                .code(502)
                .type('text/html; charset=utf-8')
                .send(htmlPage('Discord error', '<p>Could not exchange the authorization code. Try again from the launcher.</p>'));
        }

        const tokenData = (await tokenResp.json()) as DiscordTokenResponse;
        if (!tokenData.access_token) {
            return reply
                .code(502)
                .type('text/html; charset=utf-8')
                .send(htmlPage('Discord error', '<p>Discord did not return an access token. Try again from the launcher.</p>'));
        }

        // Fetch the user profile so we can UPSERT into our table.
        const userResp = await fetch('https://discord.com/api/v10/users/@me', {
            headers: {
                'Authorization': `Bearer ${tokenData.access_token}`,
                'Accept': 'application/json',
                'User-Agent': 'wol-launcher-lobby-node',
            },
        });
        if (!userResp.ok) {
            return reply
                .code(502)
                .type('text/html; charset=utf-8')
                .send(htmlPage('Discord error', '<p>Could not fetch your Discord profile.</p>'));
        }
        const du = (await userResp.json()) as DiscordUser;

        // UPSERT users. Discord's "global_name" is the new display name
        // field; if it's null we fall back to the legacy username (which
        // for newer accounts is unique and lowercase).
        const displayName = (du.global_name && du.global_name.trim()) || du.username;
        const avatarUrl = du.avatar
            ? `https://cdn.discordapp.com/avatars/${du.id}/${du.avatar}.png`
            : null;

        const existing = await ctx.db.prepare(
            'SELECT id, discord_username, display_name, avatar_url, is_banned FROM users WHERE discord_id = ?',
        ).bind(du.id).first<{
            id: string;
            discord_username: string;
            display_name: string;
            avatar_url: string | null;
            is_banned: number;
        }>();

        let effectiveUserId: string;
        if (existing) {
            if (existing.is_banned === 1) {
                return reply
                    .code(403)
                    .type('text/html; charset=utf-8')
                    .send(htmlPage('Account banned', '<p>This account is banned from multiplayer.</p>'));
            }
            effectiveUserId = existing.id;
            await ctx.db.prepare(
                `UPDATE users SET discord_username = ?, display_name = ?, avatar_url = ?, last_seen_at = datetime('now') WHERE id = ?`,
            ).bind(du.username, displayName, avatarUrl ?? existing.avatar_url, effectiveUserId).run();
        } else {
            effectiveUserId = uuid();
            await ctx.db.batch([
                ctx.db.prepare(
                    `INSERT INTO users (id, discord_id, discord_username, display_name, avatar_url)
                     VALUES (?, ?, ?, ?, ?)`,
                ).bind(effectiveUserId, du.id, du.username, displayName, avatarUrl),
                ctx.db.prepare(
                    `INSERT INTO elo_ratings (user_id, mode) VALUES (?, 'default')`,
                ).bind(effectiveUserId),
            ]);
        }

        // Stash the resolved auth result for the launcher's poll. The
        // launcher reads it once and the entry is deleted; if the
        // launcher never polls (e.g. user closed it) the TTL takes
        // care of cleanup.
        const result: AuthResult = {
            userId: effectiveUserId,
            discordId: du.id,
            discordUsername: du.username,
            displayName,
            avatarUrl,
        };
        await ctx.kv.put(
            `discord:auth-result:${q.state}`,
            JSON.stringify(result),
            { expirationTtl: RESULT_TTL_SECONDS },
        );
        // The state itself isn't needed anymore — burning it here means
        // a second-tab attacker can't reuse the same state.
        await ctx.kv.delete(`discord:auth-state:${q.state}`);

        return reply
            .type('text/html; charset=utf-8')
            .send(htmlPage(
                '✓ Signed in',
                `<p>You're signed in as <strong>${escapeHtml(displayName)}</strong>.</p>` +
                `<p>You can close this tab and return to the launcher.</p>`,
            ));
    });

    // POST /auth/login/poll — launcher polls until /callback fired.
    app.post('/auth/login/poll', {
        preHandler: [ipRateLimit(ctx, Limits.AuthPollIp)],
    }, async (req, reply) => {
        const cfg = ctx.config;

        if (cfg.devAuthBypass) {
            const userId = 'dev-user-00000001';
            const username = 'dev-user';
            await ctx.db.batch([
                ctx.db.prepare(
                    `INSERT INTO users (id, discord_id, discord_username, display_name, avatar_url)
                     VALUES (?, ?, ?, ?, NULL)
                     ON CONFLICT (discord_id) DO UPDATE SET
                       discord_username = excluded.discord_username,
                       last_seen_at = datetime('now')`,
                ).bind(userId, '0', username, 'Dev User'),
                ctx.db.prepare(
                    `INSERT OR IGNORE INTO elo_ratings (user_id, mode) VALUES (?, 'default')`,
                ).bind(userId),
            ]);
            const { token, expiresAt } = await mintSession(userId, username, cfg.jwtSigningKey);
            return reply.send({
                status: 'ok',
                token,
                expires_at: expiresAt,
                user: {
                    id: userId,
                    discord_username: username,
                    display_name: 'Dev User',
                    avatar_url: null,
                },
                config: serverConfigPayload(cfg),
            });
        }

        const body = (req.body ?? {}) as { poll_handle?: string };
        if (!body.poll_handle) throw Errors.BadRequest('poll_handle required');

        const resultJson = await ctx.kv.get(`discord:auth-result:${body.poll_handle}`);
        if (!resultJson) {
            // Either the user hasn't authorized yet or the state expired.
            // Distinguish those by checking the still-pending state row.
            const pending = await ctx.kv.get(`discord:auth-state:${body.poll_handle}`);
            if (pending) {
                return reply.code(202).send({ status: 'authorization_pending' });
            }
            throw Errors.NotFound('Poll handle');
        }

        const result = JSON.parse(resultJson) as AuthResult;
        // Burn the entry: single-use.
        await ctx.kv.delete(`discord:auth-result:${body.poll_handle}`);

        const { token, expiresAt } = await mintSession(result.userId, result.discordUsername, cfg.jwtSigningKey);
        return reply.send({
            status: 'ok',
            token,
            expires_at: expiresAt,
            user: {
                id: result.userId,
                discord_username: result.discordUsername,
                display_name: result.displayName,
                avatar_url: result.avatarUrl,
            },
            config: serverConfigPayload(cfg),
        });
    });
}

function serverConfigPayload(cfg: {
    maxConcurrentUsers: number;
    maxActiveGames: number;
    lobbyMaxPlayers: number;
    chatMsgsPerMin: number;
}) {
    return {
        max_concurrent_users: cfg.maxConcurrentUsers,
        max_active_games: cfg.maxActiveGames,
        lobby_max_players: cfg.lobbyMaxPlayers,
        chat_msgs_per_min: cfg.chatMsgsPerMin,
    };
}

/** Minimal HTML page for the /callback success/error responses. */
function htmlPage(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)} — WoL Launcher</title>
  <style>
    :root { color-scheme: dark; }
    body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
           background: #0d1117; color: #e6edf3; margin: 0;
           min-height: 100vh; display: flex; align-items: center;
           justify-content: center; padding: 24px; }
    .card { background: #161b22; border: 1px solid #30363d;
            border-radius: 12px; padding: 32px 40px; max-width: 480px;
            box-shadow: 0 8px 24px rgba(0,0,0,.35); }
    h1 { margin: 0 0 14px 0; font-size: 22px; }
    p { margin: 8px 0; line-height: 1.55; color: #b1bac4; }
    code { background: #21262d; padding: 2px 6px; border-radius: 4px;
           font-size: 90%; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    ${body}
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
