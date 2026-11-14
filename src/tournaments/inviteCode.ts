/**
 * A private tournament's invite code as somebody typed or pasted it (2026-11-13): trimmed,
 * upper-cased, and only the Crockford alphabet `shortId` mints from (no I, L, O, U). Anything
 * else is no code at all, never an error - a stranger probing must learn nothing a wrong code
 * would not tell them.
 *
 * Pure, in a module of its own so a test can import it without the routes.
 */
export function readCode(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const code = raw.trim().toUpperCase();
    return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(code) ? code : undefined;
}
