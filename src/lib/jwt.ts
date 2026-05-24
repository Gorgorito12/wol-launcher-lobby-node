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
 * Token shape: { sub: userId, gh: githubLogin, iat, exp }.
 * Sessions last 7 days; the launcher silently re-runs the device flow
 * when its stored token is within 24 h of expiry.
 */

export interface JwtPayload {
    /** Our internal user id (UUID). */
    sub: string;
    /** GitHub login at token-issue time, just for nicer log lines. */
    gh: string;
    /** Issued-at, seconds since epoch. */
    iat: number;
    /** Expiry, seconds since epoch. */
    exp: number;
}

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
 * that keeps the surface area for token-probing attacks small.
 */
export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [head, body, sig] = parts as [string, string, string];

    try {
        const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest();
        const provided = base64UrlDecode(sig);
        if (expected.length !== provided.length) return null;
        // timingSafeEqual rejects a length mismatch by throwing —
        // we just verified above so the assert is cheap.
        if (!timingSafeEqual(expected, provided)) return null;

        const payload = JSON.parse(base64UrlDecode(body).toString('utf8')) as JwtPayload;
        const now = Math.floor(Date.now() / 1000);
        if (typeof payload.exp !== 'number' || payload.exp < now) return null;
        if (typeof payload.sub !== 'string') return null;
        return payload;
    } catch {
        return null;
    }
}

/**
 * Helper to mint a 7-day session token. Centralises the expiry policy
 * so "what is a session?" is one place to change.
 */
export async function mintSession(
    userId: string,
    githubLogin: string,
    secret: string,
): Promise<{ token: string; expiresAt: number }> {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 7 * 24 * 60 * 60;
    const token = await signJwt({ sub: userId, gh: githubLogin, iat: now, exp }, secret);
    return { token, expiresAt: exp };
}
