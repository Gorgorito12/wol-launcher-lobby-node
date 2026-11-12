import type { FastifyInstance } from 'fastify';
import { Errors } from '../lib/errors';
import { mintSession, renewalRefusal } from '../lib/jwt';
import { requireAuth } from '../middleware/auth';
import { Limits, userRateLimit } from '../middleware/rateLimit';
import type { AppContext } from '../context';

/**
 * The session a launcher holds, and renewing it.
 *
 * <p><b>Why renewal exists.</b> A session token lasts 7 days and, until this route, nothing renewed
 * it: every player who stayed signed in was signed out exactly 7 days after his last Discord sign-in,
 * usually noticed hours later at a reconnect ("your multiplayer session ended"). The launcher now
 * trades a token with under three days left for a fresh one here, so a player who opens it at least
 * every few days is never signed out — until his Discord sign-in is 90 days old (src/lib/jwt.ts).</p>
 *
 * <p><b>The contract is the launcher's <c>DeviceFlowComplete</c></b>, the same body
 * <c>POST /auth/login/poll</c> answers — which is why both are built by {@link sessionResponse}. A
 * launcher that predates this route gets the not-found handler's 404 and carries on as it always did.</p>
 */

/** What the launcher is told about the server's limits at every sign-in and renewal. */
export function serverConfigPayload(cfg: {
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

/** The user as a completed sign-in describes him. */
export interface SessionUser {
    id: string;
    discordUsername: string;
    displayName: string;
    avatarUrl: string | null;
}

/**
 * The body of a completed sign-in AND of a renewal. One builder for both, because the launcher parses
 * them with one type: a key renamed in one place and not the other would sign players out at their
 * next renewal, or at their next sign-in, with nothing failing here.
 */
export function sessionResponse(
    minted: { token: string; expiresAt: number },
    user: SessionUser,
    cfg: Parameters<typeof serverConfigPayload>[0],
) {
    return {
        status: 'ok',
        token: minted.token,
        expires_at: minted.expiresAt,
        user: {
            id: user.id,
            discord_username: user.discordUsername,
            display_name: user.displayName,
            avatar_url: user.avatarUrl,
        },
        config: serverConfigPayload(cfg),
    };
}

/**
 * <c>POST /auth/refresh</c> — a still-valid session token in, a fresh one out.
 *
 * <ul>
 *   <li>No token, or one that is expired, signed with another key or malformed → 401
 *   <c>unauthorized</c> from <c>requireAuth</c>, exactly like any other route that needs a user (and
 *   the server's log says which). A dead token is never revived.</li>
 *   <li>Banned → 403 <c>user_banned</c>, also from <c>requireAuth</c>: a ban stops renewal at once.</li>
 *   <li>The account no longer exists → 401.</li>
 *   <li>The Discord sign-in is 90 days old → 403 <c>session_too_old</c>. NOT 401: the launcher signs
 *   out on a 401, and the token it holds is still good for a few days — it runs them out, and the
 *   ordinary 401 then signs the player out with the message he already knows.</li>
 * </ul>
 *
 * <p>The new token carries the CURRENT Discord username from the database (the sign-in refreshes it)
 * and the ORIGINAL sign-in time, so renewing never extends the 90-day window.</p>
 */
export function registerSessionRefresh(app: FastifyInstance, ctx: AppContext): void {
    app.post('/auth/refresh', {
        preHandler: [requireAuth(), userRateLimit(ctx, Limits.SessionRefreshUser)],
    }, async (req, reply) => {
        const cfg = ctx.config;
        const userId = req.userId!;
        const nowSec = Math.floor(Date.now() / 1000);

        const row = await ctx.db.prepare(
            `SELECT id, discord_username, display_name, avatar_url FROM users WHERE id = ?`,
        ).bind(userId).first<{
            id: string;
            discord_username: string;
            display_name: string;
            avatar_url: string | null;
        }>();
        if (!row) {
            req.log.info({ user_id: userId }, 'session renewal refused: the account no longer exists');
            throw Errors.Unauthorized();
        }

        // Dev-bypass requests carry no token, so no sign-in time: they count from now.
        const signedInAt = req.sessionSignedInAt ?? nowSec;
        const refusal = renewalRefusal(signedInAt, nowSec);
        if (refusal) {
            req.log.info({ user_id: userId, reason: refusal }, 'session renewal refused');
            throw Errors.SessionTooOld();
        }

        const minted = await mintSession(row.id, row.discord_username, cfg.jwtSigningKey, signedInAt);
        req.log.info({
            user_id: row.id,
            expires_at: new Date(minted.expiresAt * 1000).toISOString(),
            signed_in_at: new Date(signedInAt * 1000).toISOString(),
        }, 'session renewed');
        return reply.send(sessionResponse(minted, {
            id: row.id,
            discordUsername: row.discord_username,
            displayName: row.display_name,
            avatarUrl: row.avatar_url,
        }, cfg));
    });
}
