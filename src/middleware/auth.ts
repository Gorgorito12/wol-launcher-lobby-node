import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { Errors } from '../lib/errors';
import { verifyJwt } from '../lib/jwt';
import type { AppContext } from '../context';

declare module 'fastify' {
    interface FastifyRequest {
        /** Set by <c>readAuth</c> when a valid Bearer token is present. */
        userId?: string;
        discordUsername?: string;
        authenticated?: boolean;
        /** Set by <c>readAuth</c> when the authenticated user is banned. */
        banned?: boolean;
        /** Set by <c>safeRead</c> so the circuit breaker lets the request through in degraded mode. */
        safeRead?: boolean;
    }
}

/**
 * Reads a <c>Bearer &lt;jwt&gt;</c> from the Authorization header and,
 * if valid, stashes the user id on the request. Does NOT reject
 * anonymous requests — that's the job of <c>requireAuth</c>. Mounted
 * globally so per-user rate limits can see the user id for any route.
 */
export function readAuth(ctx: AppContext): preHandlerHookHandler {
    return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
        const cfg = ctx.config;
        if (cfg.devAuthBypass) {
            const header = req.headers['x-dev-user'];
            const v = Array.isArray(header) ? header[0] : header;
            if (v) {
                req.userId = v;
                req.discordUsername = v;
                req.authenticated = true;
                return;
            }
        }

        const auth = req.headers['authorization'];
        if (!auth || Array.isArray(auth)) return;

        const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
        if (!m) return;

        const payload = await verifyJwt(m[1]!, cfg.jwtSigningKey);
        if (payload) {
            req.userId = payload.sub;
            req.discordUsername = payload.du;
            req.authenticated = true;
            req.banned = await isBanned(ctx, payload.sub);
        }
    };
}

/**
 * Whether this account is banned.
 *
 * <p>Sessions are 7-day JWTs verified purely cryptographically, so without a check like this
 * one <c>users.is_banned</c> did nothing to anybody already signed in: it was read only at
 * the OAuth callback, meaning a banned player kept creating rooms, chatting and reporting
 * matches for up to a week. Nothing wrote the column either, so the whole feature was
 * inert — see <c>scripts/admin.ts player:ban</c>, which now writes it.</p>
 *
 * <p>One indexed primary-key read per authenticated request. It is deliberately here and not
 * inlined at each call site: the HTTP path and BOTH WebSocket hello handlers verify their own
 * tokens, and a ban enforced in only some of them is not a ban.</p>
 *
 * <p>Fails OPEN. A database hiccup must not lock every player out of multiplayer; the cost of
 * the opposite mistake is one banned account getting a few more minutes.</p>
 */
export async function isBanned(ctx: AppContext, userId: string): Promise<boolean> {
    try {
        const row = await ctx.db.prepare(
            `SELECT is_banned FROM users WHERE id = ?`,
        ).bind(userId).first<{ is_banned: number }>();
        return row?.is_banned === 1;
    } catch {
        return false;
    }
}

/** Reject the request when no valid session was parsed by <c>readAuth</c>. */
export function requireAuth(): preHandlerHookHandler {
    return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
        if (!req.authenticated) throw Errors.Unauthorized();
        if (req.banned) throw Errors.UserBanned();
    };
}

/** Tag the current request as a "safe read" so the circuit breaker lets it through in degraded mode. */
export function safeRead(): preHandlerHookHandler {
    return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
        req.safeRead = true;
    };
}
