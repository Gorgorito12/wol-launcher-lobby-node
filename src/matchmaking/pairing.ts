/**
 * The quick-match rules that need no socket and no database: who may meet whom, how wide a
 * player's rating window is after N seconds, which of two players hosts, and how long a strike
 * locks somebody out. Pure so they can be pinned (pairing.test.ts); the Matchmaker applies them.
 *
 * Design: docs/DISENO-PARTIDA-RAPIDA.md §7 in the launcher repo.
 */

/** What a player asked for. `either` meets both of the others. */
export type MmKind = 'ranked' | 'casual' | 'either';

/** What a pair actually plays: never `either`. */
export type MmPlayKind = 'ranked' | 'casual';

export function parseKind(raw: unknown): MmKind | null {
    return raw === 'ranked' || raw === 'casual' || raw === 'either' ? raw : null;
}

export interface MmTicket {
    id: string;
    userId: string;
    modId: string;
    modHash: string;
    kind: MmKind;
    /** The player's 1v1 rating as the server knows it. Never sent while `placing`. */
    rating: number;
    /** Still in placement: his number is unstable, so his own window is unlimited. */
    placing: boolean;
    /** Epoch ms he entered the queue. Kept across a declined match, so he keeps his place. */
    queuedAt: number;
    /** He said his Radmin is in the network; a host who can be reached is chosen first. */
    radminReady: boolean;
    /** False when he asked not to host. */
    hostOk: boolean;
}

export const BASE_WINDOW = 150;
export const WINDOW_STEP = 100;
export const WINDOW_STEP_MS = 30_000;
/** From here on anybody is better than nobody: the community is small. */
export const UNLIMITED_AFTER_MS = 120_000;

/** How far from his own rating a player accepts a rival after waiting this long. */
export function windowOf(t: Pick<MmTicket, 'placing' | 'queuedAt'>, now: number): number {
    if (t.placing) return Number.POSITIVE_INFINITY;
    const waited = Math.max(0, now - t.queuedAt);
    if (waited >= UNLIMITED_AFTER_MS) return Number.POSITIVE_INFINITY;
    return BASE_WINDOW + WINDOW_STEP * Math.floor(waited / WINDOW_STEP_MS);
}

/** What two players would play, or null when they want different things. */
export function kindsMeet(a: MmKind, b: MmKind): MmPlayKind | null {
    if (a === 'either') return b === 'either' ? 'ranked' : b;
    if (b === 'either') return a;
    return a === b ? a : null;
}

/**
 * What an `either` resolves to when it meets nobody: ranked when the mod has a ladder.
 * A challenge to a waiting `either` uses this.
 */
export function playKindFor(kind: MmKind, modRanked: boolean): MmPlayKind {
    if (kind === 'casual') return 'casual';
    if (kind === 'ranked') return 'ranked';
    return modRanked ? 'ranked' : 'casual';
}

/** Same mod, same version, compatible kind, two different people. */
export function compatible(a: MmTicket, b: MmTicket): MmPlayKind | null {
    if (a.userId === b.userId) return null;
    if (a.modId.toLowerCase() !== b.modId.toLowerCase()) return null;
    if (a.modHash.toLowerCase() !== b.modHash.toLowerCase()) return null;
    return kindsMeet(a.kind, b.kind);
}

export interface MmPair {
    a: MmTicket;
    b: MmTicket;
    kind: MmPlayKind;
}

/**
 * The pair to propose now, or null.
 *
 * Each player's rating must sit inside the OTHER's window — both have to accept the gap. Among
 * pairs that fit, the smallest gap wins; on a tie, the pair whose longer waiter has waited
 * longest; then ids, so the answer never depends on the order the map happens to hold.
 */
export function pickPair(tickets: readonly MmTicket[], now: number): MmPair | null {
    let best: { pair: MmPair; gap: number; oldest: number; key: string } | null = null;
    for (let i = 0; i < tickets.length; i++) {
        for (let j = i + 1; j < tickets.length; j++) {
            const a = tickets[i]!;
            const b = tickets[j]!;
            const kind = compatible(a, b);
            if (!kind) continue;
            const gap = Math.abs(a.rating - b.rating);
            if (gap > windowOf(a, now) || gap > windowOf(b, now)) continue;
            const oldest = Math.min(a.queuedAt, b.queuedAt);
            const key = [a.id, b.id].sort().join('|');
            if (!best
                || gap < best.gap
                || (gap === best.gap && oldest < best.oldest)
                || (gap === best.gap && oldest === best.oldest && key < best.key)) {
                best = { pair: { a, b, kind }, gap, oldest, key };
            }
        }
    }
    return best?.pair ?? null;
}

/** Who hosts: reachable over Radmin first, then willing, then whoever waited longer. */
export function chooseHost(
    a: Pick<MmTicket, 'userId' | 'radminReady' | 'hostOk' | 'queuedAt'>,
    b: Pick<MmTicket, 'userId' | 'radminReady' | 'hostOk' | 'queuedAt'>,
): string {
    if (a.radminReady !== b.radminReady) return a.radminReady ? a.userId : b.userId;
    if (a.hostOk !== b.hostOk) return a.hostOk ? a.userId : b.userId;
    if (a.queuedAt !== b.queuedAt) return a.queuedAt < b.queuedAt ? a.userId : b.userId;
    return a.userId < b.userId ? a.userId : b.userId;
}

// ---------------------------------------------------------------------------
// Strikes
// ---------------------------------------------------------------------------

export const STRIKE_DECAY_MS = 6 * 60 * 60 * 1000;

/** Strikes left after the lazy decay: one is forgiven every six hours. */
export function decayedStrikes(strikes: number, lastStrikeAt: number, now: number): number {
    if (strikes <= 0) return 0;
    const forgiven = Math.floor(Math.max(0, now - lastStrikeAt) / STRIKE_DECAY_MS);
    return Math.max(0, strikes - forgiven);
}

/** How long the Nth strike locks the queue: a warning, then 2, 10 and 30 minutes. */
export function lockForStrike(strikeNumber: number): number {
    if (strikeNumber <= 1) return 0;
    if (strikeNumber === 2) return 2 * 60_000;
    if (strikeNumber === 3) return 10 * 60_000;
    return 30 * 60_000;
}

/** Time a found match waits for both answers. */
export const ACCEPT_WINDOW_MS = 20_000;
/** Time both players have to enter the room once it is open. */
export const ROOM_ENTRY_MS = 90_000;
/** Grace after a socket drops before its ticket goes. */
export const RECONNECT_GRACE_MS = 15_000;
/** A search ends on its own after this. */
export const GIVE_UP_AFTER_MS = 30 * 60_000;
/** Post the Discord notice when nobody has turned up in this long. */
export const DISCORD_AFTER_MS = 30_000;
/** A ticket whose launcher stopped pinging for this long is gone. */
export const STALE_AFTER_MS = 60_000;
