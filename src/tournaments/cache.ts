/**
 * The tournament list and detail memos, in a module of their own so that EVERY writer can
 * reach them — not only the tournament routes.
 *
 * <p>They used to live inside `tournaments/rest.ts`, which made them invisible to the one
 * writer that matters most: a reported game advancing the bracket (`advance.ts`, reached from
 * `matches/rest.ts`). That write never invalidated anything, so for up to a minute after a
 * match the players were pushed "you won" while the bracket they opened still showed the
 * match undecided.</p>
 */

export const CACHE_TTL_MS = 60_000;

/**
 * The detail memo, capped.
 *
 * The four memos in `stats/rest.ts` are single slots because their payloads take no
 * parameters. This one is keyed by an id the CLIENT supplies, so an uncapped Map is a
 * memory leak anybody can drive on a 1 GB box just by walking ids. Oldest-out at 50 keeps
 * the busy tournaments hot and bounds the worst case.
 */
const DETAIL_CACHE_MAX = 50;
const detailCache = new Map<string, { at: number; payload: unknown }>();

let listCache: { at: number; payload: unknown } | null = null;

export function readDetailCache(id: string): unknown | null {
    const hit = detailCache.get(id);
    if (!hit || Date.now() - hit.at >= CACHE_TTL_MS) return null;
    return hit.payload;
}

export function writeDetailCache(id: string, payload: unknown): void {
    if (detailCache.size >= DETAIL_CACHE_MAX && !detailCache.has(id)) {
        // Map iterates in insertion order, so the first key is the oldest.
        const oldest = detailCache.keys().next().value;
        if (oldest !== undefined) detailCache.delete(oldest);
    }
    detailCache.set(id, { at: Date.now(), payload });
}

export function readListCache(now: number): unknown | null {
    return listCache && now - listCache.at < CACHE_TTL_MS ? listCache.payload : null;
}

export function writeListCache(payload: unknown, now: number): void {
    listCache = { at: now, payload };
}

/** Every write must call this, or readers serve a bracket that predates the change. */
export function invalidateTournament(id: string): void {
    detailCache.delete(id);
    listCache = null;
}
