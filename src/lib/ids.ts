import { randomUUID, randomBytes, createHash } from 'node:crypto';

/**
 * Same id-mint contract as the Worker: a full UUID v4 for entities the
 * user never types, and an 8-char Crockford base32 short id for things
 * that show up in URLs and chat ("join /lobby/3K7N9P2X").
 *
 * Crockford excludes I L O U so the short ids can be read aloud without
 * confusing 1/I, 0/O, etc.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I L O U

export function uuid(): string {
    return randomUUID();
}

export function shortId(len = 8): string {
    const bytes = randomBytes(len);
    let out = '';
    for (let i = 0; i < len; i++) {
        out += CROCKFORD[bytes[i]! % CROCKFORD.length];
    }
    return out;
}

/**
 * SHA-256 → lowercase hex. Matches the Worker's <c>sha256Hex</c>
 * byte-for-byte, so a password hash made on Cloudflare is still
 * verifiable here. node:crypto's sync API is plenty fast for the
 * few-hundred-passwords-per-day this gets used for.
 */
export async function sha256Hex(input: string): Promise<string> {
    return createHash('sha256').update(input).digest('hex');
}
