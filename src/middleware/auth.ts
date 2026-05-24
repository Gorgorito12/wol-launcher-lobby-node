import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { Errors } from '../lib/errors.js';
import { verifyJwt } from '../lib/jwt.js';
import type { AppContext } from '../context.js';

declare module 'fastify' {
    interface FastifyRequest {
        /** Set by <c>readAuth</c> when a valid Bearer token is present. */
        userId?: string;
        githubLogin?: string;
        authenticated?: boolean;
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
                req.githubLogin = v;
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
            req.githubLogin = payload.gh;
            req.authenticated = true;
        }
    };
}

/** Reject the request when no valid session was parsed by <c>readAuth</c>. */
export function requireAuth(): preHandlerHookHandler {
    return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
        if (!req.authenticated) throw Errors.Unauthorized();
    };
}

/** Tag the current request as a "safe read" so the circuit breaker lets it through in degraded mode. */
export function safeRead(): preHandlerHookHandler {
    return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
        req.safeRead = true;
    };
}
