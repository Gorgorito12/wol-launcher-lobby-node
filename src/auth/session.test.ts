/**
 * POST /auth/refresh end to end: a real Fastify app with the real readAuth hook, the real route, the
 * real requireAuth and rate limiter, over a tiny in-memory stand-in for the users table. Run:
 * `npm test`.
 *
 * <p>The database is a stand-in on purpose: every other test here is pure and runs on any Node, while
 * the native better-sqlite3 in node_modules is built for the server's Node — a test that opened it
 * would fail on a developer machine with a different Node for a reason that has nothing to do with
 * sessions. The stand-in answers the three statements this path runs (the ban check, the launcher-
 * version note, the route's own read) and fails loudly on anything else.</p>
 *
 * <p>The REFUSALS are the point. A token that is dead (expired, another key, garbage) must never be
 * revived; a banned account must not renew; and a session whose Discord sign-in is 90 days old must be
 * refused with 403 `session_too_old` and NEVER 401 — a launcher signs the player out on a 401, while
 * the token it holds still has days to run.</p>
 *
 * <p>The 200 body is pinned key by key because the launcher parses it with the same type as a completed
 * sign-in (`DeviceFlowComplete`): a renamed key would sign players out at their next renewal, with
 * nothing failing here.</p>
 */
import test from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { readAuth } from "../middleware/auth.js";
import { HttpError, apiError } from "../lib/errors.js";
import { mintSession, signJwt, verifyJwt } from "../lib/jwt.js";
import { registerSessionRefresh } from "./session.js";
import type { AppContext } from "../context.js";

const KEY = "session-test-key";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

interface UserRow {
    id: string;
    discord_username: string;
    display_name: string;
    avatar_url: string | null;
    is_banned: number;
}

/** Just enough of `Db` for this path: `prepare(sql).bind(...).first()/.run()`. */
function usersDb(rows: UserRow[]) {
    const users = new Map(rows.map((r) => [r.id, r]));
    return {
        prepare(sql: string) {
            return {
                bind(...args: unknown[]) {
                    return {
                        async first<T>(): Promise<T | null> {
                            if (/FROM users WHERE id = \?/.test(sql)) return (users.get(String(args[0])) ?? null) as T | null;
                            throw new Error(`the test stand-in does not know this statement: ${sql}`);
                        },
                        async run() {
                            if (/^\s*UPDATE users SET last_launcher_version/.test(sql)) return { changes: 1 };
                            throw new Error(`the test stand-in does not know this statement: ${sql}`);
                        },
                    };
                },
            };
        },
    };
}

/** Just enough of `KvStore` for the rate limiter. */
function memoryKv() {
    const map = new Map<string, string>();
    return {
        async get(key: string) { return map.get(key) ?? null; },
        async put(key: string, value: string) { map.set(key, value); },
        async delete(key: string) { map.delete(key); },
    };
}

async function buildApp(): Promise<FastifyInstance> {
    const ctx = {
        db: usersDb([
            { id: "user-1", discord_username: "renamed-now", display_name: "Player One", avatar_url: null, is_banned: 0 },
            { id: "banned-1", discord_username: "banned", display_name: "Banned One", avatar_url: null, is_banned: 1 },
        ]),
        kv: memoryKv(),
        config: {
            jwtSigningKey: KEY,
            devAuthBypass: false,
            maxConcurrentUsers: 60,
            maxActiveGames: 8,
            lobbyMaxPlayers: 8,
            chatMsgsPerMin: 30,
        },
    } as unknown as AppContext;

    const app = Fastify();
    app.addHook("preHandler", readAuth(ctx));
    // The same envelope index.ts sets, so the launcher-facing codes are what is asserted.
    app.setErrorHandler((err: Error, _req: FastifyRequest, reply: FastifyReply) => {
        if (err instanceof HttpError) {
            reply.code(err.status).type("application/json").send(apiError(err.code, err.message, err.details));
            return;
        }
        reply.code(500).type("application/json").send(apiError("internal", String(err)));
    });
    registerSessionRefresh(app, ctx);
    await app.ready();
    return app;
}

function refresh(app: FastifyInstance, token?: string) {
    return app.inject({
        method: "POST",
        url: "/auth/refresh",
        headers: token ? { authorization: `Bearer ${token}` } : {},
    });
}

test("a valid session is renewed, keeps its sign-in time and takes the CURRENT username", async () => {
    const app = await buildApp();
    try {
        const signedInAt = NOW - 10 * DAY;
        const old = (await mintSession("user-1", "old-name", KEY, signedInAt)).token;

        const res = await refresh(app, old);
        assert.equal(res.statusCode, 200, res.body);
        const body = res.json();
        const renewed = await verifyJwt(body.token, KEY);
        assert.ok(renewed, "the new token must verify");
        assert.equal(renewed.sub, "user-1");
        assert.equal(renewed.du, "renamed-now");
        assert.equal(renewed.sat, signedInAt, "renewing must never move the 90-day window");
        assert.equal(body.expires_at, renewed.exp);
        assert.ok(body.expires_at > NOW + 6 * DAY);
    } finally {
        await app.close();
    }
});

test("the body is exactly what a completed sign-in answers", async () => {
    const app = await buildApp();
    try {
        const res = await refresh(app, (await mintSession("user-1", "x", KEY)).token);
        const body = res.json();
        assert.deepEqual(Object.keys(body).sort(), ["config", "expires_at", "status", "token", "user"]);
        assert.equal(body.status, "ok");
        assert.deepEqual(body.user, {
            id: "user-1",
            discord_username: "renamed-now",
            display_name: "Player One",
            avatar_url: null,
        });
        assert.deepEqual(Object.keys(body.config).sort(),
            ["chat_msgs_per_min", "lobby_max_players", "max_active_games", "max_concurrent_users"]);
    } finally {
        await app.close();
    }
});

test("a token from before renewal existed (no sat) counts its window from iat", async () => {
    const app = await buildApp();
    try {
        const iat = NOW - 2 * DAY;
        const legacy = await signJwt({ sub: "user-1", du: "x", iat, exp: iat + 7 * DAY }, KEY);
        const res = await refresh(app, legacy);
        assert.equal(res.statusCode, 200, res.body);
        assert.equal((await verifyJwt(res.json().token, KEY))?.sat, iat);
    } finally {
        await app.close();
    }
});

test("a dead token is never revived: expired, another key, garbage or none are all 401", async () => {
    const app = await buildApp();
    try {
        const expired = await signJwt(
            { sub: "user-1", du: "x", iat: NOW - 8 * DAY, exp: NOW - 60, sat: NOW - 8 * DAY }, KEY);
        const otherKey = (await mintSession("user-1", "x", "some-other-key")).token;
        for (const token of [expired, otherKey, "not-a-token", undefined]) {
            const res = await refresh(app, token);
            assert.equal(res.statusCode, 401, `${token ?? "(no header)"}: ${res.body}`);
            assert.equal(res.json().code, "unauthorized");
        }
    } finally {
        await app.close();
    }
});

test("a banned account cannot renew", async () => {
    const app = await buildApp();
    try {
        const res = await refresh(app, (await mintSession("banned-1", "banned", KEY)).token);
        assert.equal(res.statusCode, 403);
        assert.equal(res.json().code, "user_banned");
    } finally {
        await app.close();
    }
});

test("an account that no longer exists cannot renew", async () => {
    const app = await buildApp();
    try {
        const res = await refresh(app, (await mintSession("gone-1", "gone", KEY)).token);
        assert.equal(res.statusCode, 401);
    } finally {
        await app.close();
    }
});

test("THE_ONE_THAT_MATTERS_ANinetyDayOldSignInIsRefusedWith403NeverWith401", async () => {
    const app = await buildApp();
    try {
        // Still in date — the launcher may use it for days yet — but signed in 91 days ago.
        const old = await signJwt(
            { sub: "user-1", du: "x", iat: NOW - DAY, exp: NOW + 6 * DAY, sat: NOW - 91 * DAY }, KEY);
        const res = await refresh(app, old);
        assert.equal(res.statusCode, 403, res.body);
        assert.equal(res.json().code, "session_too_old");

        // The token itself keeps working until it runs out: refusing to RENEW is not signing out.
        assert.ok(await verifyJwt(old, KEY));
    } finally {
        await app.close();
    }
});
