import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { Errors } from '../lib/errors';
import { inspectJwt, sessionSignedInAt, type JwtRefusal } from '../lib/jwt';
import { meetsMinimum } from '../lib/launcherVersion';
import type { AppContext } from '../context';

declare module 'fastify' {
    interface FastifyRequest {
        /** Set by <c>readAuth</c> when a valid Bearer token is present. */
        userId?: string;
        discordUsername?: string;
        authenticated?: boolean;
        /** When this session's Discord sign-in happened (Unix s) — see <c>sessionSignedInAt</c>. */
        sessionSignedInAt?: number;
        /**
         * Set by <c>readAuth</c> when a Bearer token was SENT and refused. Logged only where a route
         * that needs a user answers 401 (<c>refuseUnauthenticated</c>), never in <c>readAuth</c>: a
         * launcher with a dead token polls public routes every few seconds.
         */
        authFailure?: { reason: JwtRefusal; sub?: string; exp?: number };
        /** Set by <c>readAuth</c> when the authenticated user is banned. */
        banned?: boolean;
        /** The launcher build that sent this request, from X-Launcher-Version. */
        launcherVersion?: string;
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
/** Header the launcher reports its own build in, e.g. "v1.0.14". */
export const LAUNCHER_VERSION_HEADER = 'x-launcher-version';

/** Read it off a request, or "" when the client did not send one. */
export function launcherVersionOf(req: { headers: Record<string, unknown> }): string {
    const raw = req.headers[LAUNCHER_VERSION_HEADER];
    const v = Array.isArray(raw) ? raw[0] : raw;
    return typeof v === 'string' ? v.trim().slice(0, 32) : '';
}

/**
 * Remember which launcher build each player is on, so an operator can see what setting a
 * minimum would actually cost before setting it.
 *
 * <p>Kept honest about the write cost: the value changes only when somebody updates, so a
 * per-process memo means one UPDATE per user per new version rather than one per request.
 * Losing the memo on restart costs one extra write each; getting it wrong would cost a
 * database write on every authenticated call.</p>
 */
const lastSeenVersion = new Map<string, string>();

function rememberLauncherVersion(ctx: AppContext, userId: string, version: string): void {
    if (!version || lastSeenVersion.get(userId) === version) return;
    lastSeenVersion.set(userId, version);
    void ctx.db.prepare(
        `UPDATE users SET last_launcher_version = ? WHERE id = ?`,
    ).bind(version, userId).run().catch(() => { /* best-effort telemetry, never a blocker */ });
}

/**
 * Refuse multiplayer ENTRY to a launcher older than Config.minLauncherVersion.
 *
 * <p>Deliberately not applied to everything: match reports, history, stats and the global chat
 * stay open. A client that already played should still be able to report it, and somebody being
 * turned away should still be able to ask why.</p>
 */
export function requireLauncherVersion(ctx: AppContext): preHandlerHookHandler {
    return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
        const min = ctx.config.minLauncherVersion;
        if (!min) return;                     // off by default
        if (meetsMinimum(req.launcherVersion, min)) return;
        throw Errors.LauncherTooOld(min);
    };
}

export function readAuth(ctx: AppContext): preHandlerHookHandler {
    return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
        const cfg = ctx.config;
        req.launcherVersion = launcherVersionOf(req as unknown as { headers: Record<string, unknown> });
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

        const inspection = await inspectJwt(m[1]!, cfg.jwtSigningKey);
        if (inspection.ok) {
            const payload = inspection.payload;
            req.userId = payload.sub;
            req.discordUsername = payload.du;
            req.authenticated = true;
            req.sessionSignedInAt = sessionSignedInAt(payload);
            req.banned = await isBanned(ctx, payload.sub);
            rememberLauncherVersion(ctx, payload.sub, req.launcherVersion ?? '');
        } else {
            // Still anonymous, exactly as before — public routes answer as they always did. The
            // reason is kept for the one place it is worth a log line.
            req.authFailure = { reason: inspection.reason, sub: inspection.sub, exp: inspection.exp };
        }
    };
}

/**
 * Answer 401 to a request that needed a user — and, when it SENT a token, say in the server's log why
 * that token was refused. The client still gets the same <c>unauthorized</c> for every cause, which
 * keeps token probing blind; what changes is that an operator reading the journal can tell a lifetime
 * that ran out (<c>expired</c>) from a signing key that changed (<c>bad_signature</c> on a token whose
 * <c>exp</c> is still ahead) from a client sending garbage (<c>malformed</c>). Before this, every one of
 * them was the same generic 401 in the request log.
 */
function refuseUnauthenticated(req: FastifyRequest): never {
    const failure = req.authFailure;
    if (failure) {
        req.log.info({
            reason: failure.reason,
            sub: failure.sub,
            exp: typeof failure.exp === 'number' ? new Date(failure.exp * 1000).toISOString() : undefined,
            url: req.url,
        }, 'session token refused');
    }
    throw Errors.Unauthorized();
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
        if (!req.authenticated) refuseUnauthenticated(req);
        if (req.banned) throw Errors.UserBanned();
    };
}

/**
 * Refuse anybody who is not the owner of the tournament named in the path.
 *
 * There is no GLOBAL role anywhere in this database — no moderator, no staff flag on
 * `users` — and that is still the point: nobody wants to be granting permissions by hand.
 * The permission is a row. Whoever created a tournament may do everything to it and
 * nothing at all to anybody else's, the same shape as `lobbies.host_user_id` gating kick
 * and start.
 *
 * What changed in 0016 is that a tournament's owner may let somebody help run THAT
 * tournament — see `requireTournamentManager` below. The maintainer still grants nothing.
 *
 * Shaped like `requireLauncherVersion` (a factory closing over `ctx`) rather than
 * `requireAuth` (which needs none), because it has to read a row.
 *
 * **Fails CLOSED.** `isBanned` above swallows a database error and answers "not banned",
 * which is the right call for a check that only ever takes privileges away. This one
 * GRANTS them, so a failed read must deny — hence no try/catch here at all: a thrown
 * database error becomes a 500 and the action does not happen.
 *
 * Order matters: a tournament that does not exist answers 404 rather than 403, so a
 * mistyped id is never reported as somebody else's tournament.
 */
export function requireTournamentOwner(ctx: AppContext): preHandlerHookHandler {
    return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
        if (!req.authenticated) refuseUnauthenticated(req);
        if (req.banned) throw Errors.UserBanned();

        const id = (req.params as { id?: string }).id ?? '';
        const row = await ctx.db.prepare(
            `SELECT owner_user_id FROM tournaments WHERE id = ?`,
        ).bind(id).first<{ owner_user_id: string }>();

        if (!row) throw Errors.NotFound('Tournament');
        if (row.owner_user_id !== req.userId) throw Errors.Forbidden();
    };
}

/**
 * Refuse anybody who is neither the owner of the tournament named in the path nor one of
 * the co-organisers its owner appointed.
 *
 * Everything `requireTournamentOwner` says applies here unchanged, and all four of its
 * load-bearing properties are kept deliberately:
 *
 *   * auth and ban first;
 *   * **fails CLOSED** — no try/catch at all, so a database error becomes a 500 and the
 *     action does not happen. This guard GRANTS, and a check that grants must deny when it
 *     cannot read;
 *   * **404 before 403**, so a mistyped id is never reported as somebody else's tournament;
 *   * raw statements here rather than a call into `tournaments/store`, because this file
 *     imports nothing from a feature store and one exception would start the cycle.
 *
 * **Two reads and not one join.** `SELECT ... FROM tournaments t LEFT JOIN
 * tournament_managers m ... WHERE t.id = ? AND (owner = ? OR m.user_id = ?)` would answer
 * the question in one round trip and collapse "no such tournament" into "not allowed",
 * which is exactly the distinction the ordering above exists to preserve. The second read
 * only happens for somebody who is not the owner.
 *
 * What this does NOT guard: cancelling, and appointing or removing a manager. Those keep
 * `requireTournamentOwner` — a manager who can appoint managers is the same hole
 * `tournament:transfer` is a maintainer command to avoid.
 */
export function requireTournamentManager(ctx: AppContext): preHandlerHookHandler {
    return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
        if (!req.authenticated) refuseUnauthenticated(req);
        if (req.banned) throw Errors.UserBanned();

        const id = (req.params as { id?: string }).id ?? '';
        const row = await ctx.db.prepare(
            `SELECT owner_user_id FROM tournaments WHERE id = ?`,
        ).bind(id).first<{ owner_user_id: string }>();

        if (!row) throw Errors.NotFound('Tournament');
        if (row.owner_user_id === req.userId) return;

        const manager = await ctx.db.prepare(
            `SELECT 1 AS ok FROM tournament_managers WHERE tournament_id = ? AND user_id = ?`,
        ).bind(id, req.userId).first<{ ok: number }>();

        if (!manager) throw Errors.Forbidden();
    };
}

/** Tag the current request as a "safe read" so the circuit breaker lets it through in degraded mode. */
export function safeRead(): preHandlerHookHandler {
    return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
        req.safeRead = true;
    };
}
