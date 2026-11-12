/**
 * Session tokens: why one is refused, and how long a session may be renewed. Run: `npm test`.
 *
 * <p>The refusal REASONS only ever reach the server's log — the client gets the same 401 for all of
 * them — but they are what separates the three causes of "your multiplayer session ended": a lifetime
 * that ran out, a signing key that changed, and a client sending something that is not a token.
 * `verifyJwt`'s contract (null for every one of them) is pinned beside them, because both WebSocket
 * hellos still call it.</p>
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    inspectJwt,
    mintSession,
    renewalRefusal,
    sessionSignedInAt,
    signJwt,
    verifyJwt,
    SESSION_MAX_AGE_SECONDS,
    SESSION_TTL_SECONDS,
} from "./jwt.js";

const KEY = "test-signing-key";
const OTHER_KEY = "a-different-key";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function decode(token: string): Record<string, unknown> {
    const body = token.split(".")[1]!;
    return JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

test("a minted session verifies, lasts seven days, and records when it was signed in", async () => {
    const { token, expiresAt } = await mintSession("user-1", "player", KEY);
    const payload = await verifyJwt(token, KEY);
    assert.ok(payload);
    assert.equal(payload.sub, "user-1");
    assert.ok(Math.abs(expiresAt - (NOW + SESSION_TTL_SECONDS)) <= 5);
    assert.ok(typeof payload.sat === "number" && Math.abs(payload.sat - NOW) <= 5,
        "a sign-in starts the 90-day window now");
});

test("a renewal carries the ORIGINAL sign-in time, so renewing never extends the window", async () => {
    const signedInAt = NOW - 40 * DAY;
    const { token } = await mintSession("user-1", "player", KEY, signedInAt);
    assert.equal(decode(token).sat, signedInAt);
});

test("each refusal has its own reason — and verifyJwt stays null for all of them", async () => {
    const good = (await mintSession("user-1", "player", KEY)).token;

    // A key that changed: the token is still in date, so the reason must not read "expired".
    const wrongKey = await inspectJwt(good, OTHER_KEY);
    assert.equal(wrongKey.ok, false);
    if (!wrongKey.ok) {
        assert.equal(wrongKey.reason, "bad_signature");
        assert.equal(wrongKey.sub, "user-1", "the log should still say whose token it was");
        assert.ok(typeof wrongKey.exp === "number" && wrongKey.exp > NOW);
    }

    // A lifetime that ran out.
    const expired = await signJwt({ sub: "user-1", du: "player", iat: NOW - 8 * DAY, exp: NOW - DAY }, KEY);
    const expiredInspection = await inspectJwt(expired, KEY);
    assert.equal(expiredInspection.ok, false);
    if (!expiredInspection.ok) {
        assert.equal(expiredInspection.reason, "expired");
        assert.equal(expiredInspection.exp, NOW - DAY);
    }

    // Not a token at all.
    for (const garbage of ["", "abc", "a.b", "a.b.c.d"]) {
        const inspection = await inspectJwt(garbage, KEY);
        assert.equal(inspection.ok, false, garbage);
        if (!inspection.ok) assert.equal(inspection.reason, "malformed", garbage);
    }

    // A payload edited after signing.
    const [head, , sig] = good.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ sub: "someone-else", du: "x", iat: NOW, exp: NOW + DAY }))
        .toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const tampered = await inspectJwt(`${head}.${forgedBody}.${sig}`, KEY);
    assert.equal(tampered.ok, false);
    if (!tampered.ok) assert.equal(tampered.reason, "bad_signature");

    // Correctly signed, but not a session.
    const noExpiry = await signJwt({ sub: "user-1", du: "player", iat: NOW } as never, KEY);
    const noExpiryInspection = await inspectJwt(noExpiry, KEY);
    assert.equal(noExpiryInspection.ok, false);
    if (!noExpiryInspection.ok) assert.equal(noExpiryInspection.reason, "bad_payload");

    for (const token of [expired, "abc", `${head}.${forgedBody}.${sig}`, noExpiry]) {
        assert.equal(await verifyJwt(token, KEY), null);
    }
    assert.equal(await verifyJwt(good, OTHER_KEY), null);
});

test("a token minted before renewal existed counts its window from iat", () => {
    assert.equal(sessionSignedInAt({ iat: NOW - 3 * DAY }), NOW - 3 * DAY);
    assert.equal(sessionSignedInAt({ iat: NOW - 3 * DAY, sat: NOW - 50 * DAY }), NOW - 50 * DAY);
});

test("THE_ONE_THAT_MATTERS_RenewalStopsExactlyNinetyDaysAfterTheSignIn", () => {
    assert.equal(SESSION_MAX_AGE_SECONDS, 90 * DAY);
    assert.equal(renewalRefusal(NOW - 89 * DAY, NOW), null);
    assert.equal(renewalRefusal(NOW - SESSION_MAX_AGE_SECONDS + 1, NOW), null);
    assert.ok(renewalRefusal(NOW - SESSION_MAX_AGE_SECONDS, NOW));
    assert.ok(renewalRefusal(NOW - 91 * DAY, NOW));
    assert.ok(renewalRefusal(Number.NaN, NOW), "an unreadable sign-in time is never renewed");
});
