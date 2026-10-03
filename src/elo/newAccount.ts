/**
 * New account, very short match, same network as the opponent: the match does not rate.
 *
 * <p><b>What it is for.</b> The cheapest way to farm a ladder is a second account on the same PC:
 * create it, start a room, lose on purpose in a minute, repeat. Each of those three signals is
 * innocent on its own — everybody's account was new once, real games end early, and brothers and
 * flatmates share a router (and this player base is full of CGNAT, where unrelated people share an
 * address) — so the rule asks for ALL THREE at once, and even then it only withholds the rating:
 * the match is stored and shown like any other, with the reason.</p>
 *
 * <ul>
 *   <li>at least one of the two accounts is younger than {@link NEW_ACCOUNT_AGE_MS} at the moment
 *       the match was stored (never "now": a replay must reach the same answer);</li>
 *   <li>the match lasted less than the configured threshold
 *       (`NEW_ACCOUNT_SHORT_MATCH_SECONDS`, 10 minutes by default);</li>
 *   <li>the two were OPPONENTS sharing an IP hash. Teammates sharing one never trigger it: two
 *       friends on one LAN playing together is the most ordinary thing in the world.</li>
 * </ul>
 *
 * <p>Missing IP data answers false: a match is never refused on a guess. Pure.</p>
 */

export const NEW_ACCOUNT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface NewAccountParticipant {
    userId: string;
    /** Side number; equal numbers are teammates. A 1v1 passes two different values. */
    side: number;
    accountCreatedMs: number | null;
    ipHashes: ReadonlySet<string>;
}

export interface NewAccountInput {
    participants: readonly NewAccountParticipant[];
    durationSeconds: number;
    matchAtMs: number;
    shortSeconds: number;
}

function isNew(p: NewAccountParticipant, atMs: number): boolean {
    return p.accountCreatedMs !== null && atMs - p.accountCreatedMs < NEW_ACCOUNT_AGE_MS;
}

export function isNewAccountShort(input: NewAccountInput): boolean {
    if (!(input.durationSeconds < input.shortSeconds)) return false;
    const ps = input.participants;
    for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
            const a = ps[i]!;
            const b = ps[j]!;
            if (a.side === b.side) continue;
            if (!isNew(a, input.matchAtMs) && !isNew(b, input.matchAtMs)) continue;
            for (const h of a.ipHashes) {
                if (b.ipHashes.has(h)) return true;
            }
        }
    }
    return false;
}
