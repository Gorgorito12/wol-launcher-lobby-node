import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal HMAC-SHA256 JWT (HS256) signer/verifier.
 *
 * Byte-for-byte compatible with the Worker's original implementation —
 * a session token minted by the Worker is still valid here as long as
 * <c>JWT_SIGNING_KEY</c> is the same on both sides. That's how
 * sign-ins survive the cutover from Cloudflare to the VM without users
 * having to re-authenticate.
 *
 * Token shape: { sub: userId, du: discordUsername, iat, exp, sat? }.
 *
 * <p><b>A token lasts 7 days, and a SESSION can last 90.</b> The launcher renews its token through
 * <c>POST /auth/refresh</c> (<c>src/auth/session.ts</c>) once it has under three days left, so a
 * player who opens the launcher at least every few days is never signed out — until his last Discord
 * sign-in (<c>sat</c>) is {@link SESSION_MAX_AGE_SECONDS} old, when renewal is refused and the token he
 * holds simply runs out. A launcher without the renewal client signs in again every 7 days.</p>
 *
 * <p>This comment used to say the launcher "silently re-runs the device flow when its stored token is
 * within 24 h of expiry". No launcher ever did — the Discord flow needs the player's browser — and
 * every player who stayed signed in was signed out exactly 7 days after his last sign-in.</p>
 */

/** How long one token is valid. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * How long after the player's last Discord sign-in a token may still be renewed. Without a bound, a
 * leaked token could be renewed for ever, and with no per-token revocation the only way to stop it
 * would be a ban or rotating the key for everybody. The last token minted inside the window still runs
 * its {@link SESSION_TTL_SECONDS}, so a session ends at most ~97 days after the sign-in.
 */
export const SESSION_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;

export interface JwtPayload {
    /** Our internal user id (UUID). */
    sub: string;
    /** Discord username at token-issue time, just for nicer log lines. */
    du: string;
    /** Issued-at, seconds since epoch. */
    iat: number;
    /** Expiry, seconds since epoch. */
    exp: number;
    /**
     * When the player signed in with Discord ("signed in at"), seconds since epoch. Set by the sign-in,
     * carried unchanged by every renewal. Absent from tokens minted before renewal existed — their
     * <c>iat</c> stands in (see {@link sessionSignedInAt}).
     */
    sat?: number;
}

/** Why a token was refused. Only ever LOGGED — callers answer the client the same 401 for all of them. */
export type JwtRefusal = 'malformed' | 'bad_signature' | 'expired' | 'bad_payload';

export type JwtInspection =
    | { ok: true; payload: JwtPayload }
    | {
        ok: false;
        reason: JwtRefusal;
        /** From the UNVERIFIED payload, for the server log only. Never trust it for anything else. */
        sub?: string;
        /** From the UNVERIFIED payload, for the server log only. */
        exp?: number;
    };

function base64UrlEncode(buf: Buffer): string {
    return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(input: string): Buffer {
    const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
    const b64 = (input + pad).replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, 'base64');
}

export async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
    const header = { alg: 'HS256', typ: 'JWT' };
    const head = base64UrlEncode(Buffer.from(JSON.stringify(header), 'utf8'));
    const body = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
    const data = `${head}.${body}`;
    const sig = createHmac('sha256', secret).update(data).digest();
    return `${data}.${base64UrlEncode(sig)}`;
}

/**
 * Verify and decode a token. Returns null for any failure: bad shape,
 * bad signature, expired. Callers never see why a token is invalid —
 * that keeps the surface area for token-probing attacks small. The
 * server's own log can: see {@link inspectJwt}.
 */
export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
    const inspection = await inspectJwt(token, secret);
    return inspection.ok ? inspection.payload : null;
}

/**
 * {@link verifyJwt} with the reason a token was refused, for the server's log. "Your multiplayer
 * session ended" had three causes and the log could not tell them apart: a lifetime that ran out
 * (<c>expired</c>), a signing key that changed (<c>bad_signature</c> on a token that has not expired),
 * and a client sending something that is not a token at all. The reason never reaches the client.
 */
export async function inspectJwt(
    token: string,
    secret: string,
    nowSec: number = Math.floor(Date.now() / 1000),
): Promise<JwtInspection> {
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    const [head, body, sig] = parts as [string, string, string];

    // What the payload SAYS, read before anything is trusted — only so a refusal can be logged with
    // whose token it was and when it expired.
    let claimed: { sub?: unknown; exp?: unknown } | null = null;
    try {
        claimed = JSON.parse(base64UrlDecode(body).toString('utf8')) as { sub?: unknown; exp?: unknown };
    } catch {
        claimed = null;
    }
    const claimedSub = typeof claimed?.sub === 'string' ? claimed.sub : undefined;
    const claimedExp = typeof claimed?.exp === 'number' ? claimed.exp : undefined;

    try {
        const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest();
        const provided = base64UrlDecode(sig);
        if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
            return { ok: false, reason: 'bad_signature', sub: claimedSub, exp: claimedExp };
        }
    } catch {
        return { ok: false, reason: 'malformed' };
    }

    if (claimed === null) return { ok: false, reason: 'bad_payload' };
    const payload = claimed as JwtPayload;
    if (typeof payload.exp !== 'number' || typeof payload.sub !== 'string') {
        return { ok: false, reason: 'bad_payload', sub: claimedSub, exp: claimedExp };
    }
    if (payload.exp < nowSec) return { ok: false, reason: 'expired', sub: payload.sub, exp: payload.exp };
    return { ok: true, payload };
}

/**
 * Helper to mint a 7-day session token. Centralises the expiry policy
 * so "what is a session?" is one place to change.
 *
 * @param signedInAt When the player signed in with Discord. Omitted by the sign-in itself (it is
 *   now); a renewal passes the session's original value so the 90-day bound counts from the sign-in.
 */
export async function mintSession(
    userId: string,
    discordUsername: string,
    secret: string,
    signedInAt?: number,
): Promise<{ token: string; expiresAt: number }> {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + SESSION_TTL_SECONDS;
    const sat = typeof signedInAt === 'number' && Number.isFinite(signedInAt) ? signedInAt : now;
    const token = await signJwt({ sub: userId, du: discordUsername, iat: now, exp, sat }, secret);
    return { token, expiresAt: exp };
}

/**
 * When this session's Discord sign-in happened: <c>sat</c>, or — for a token minted before renewal
 * existed — its <c>iat</c>, which for such a token IS the sign-in. Using <c>iat</c> can only ever give
 * an existing session MORE time than the truth, never less.
 */
export function sessionSignedInAt(payload: Pick<JwtPayload, 'iat' | 'sat'>): number {
    return typeof payload.sat === 'number' && Number.isFinite(payload.sat) ? payload.sat : payload.iat;
}

/**
 * Why a session may not be renewed, or null when it may. Pure, so the 90-day boundary is pinned by a
 * test rather than by a comment.
 */
export function renewalRefusal(signedInAt: number, nowSec: number): string | null {
    if (!Number.isFinite(signedInAt)) return 'the session carries no sign-in time';
    const age = nowSec - signedInAt;
    if (age >= SESSION_MAX_AGE_SECONDS) {
        return `the Discord sign-in is ${Math.floor(age / 86_400)} days old (the limit is `
            + `${SESSION_MAX_AGE_SECONDS / 86_400})`;
    }
    return null;
}
