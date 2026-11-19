/**
 * Slots a tournament may offer, counted in ENTRANTS.
 *
 * The first round of 32 is sixteen rooms and of 64 is thirty-two, and MAX_ACTIVE_GAMES is 16 for
 * the whole server by default. That no longer forbids the size, because a round is not played all
 * at once: a room is opened when its two entrants are ready, and one that finds the server full
 * gets the ordinary "Server full" refusal and can try again when a match ends. An operator who
 * runs one of these should raise MAX_ACTIVE_GAMES first; the cost of a room is a row and a socket,
 * and tournament rooms do not announce themselves, so raising it is cheap (src/lobbies/create.ts).
 */
export const MIN_CAPACITY = 2;
export const MAX_CAPACITY = 64;
export const DEFAULT_CAPACITY = 8;

/** A number out of a request body, inside the limits. Anything else is the default. */
export function clampCapacity(raw: unknown): number {
    const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_CAPACITY;
    return Math.min(MAX_CAPACITY, Math.max(MIN_CAPACITY, n));
}

/**
 * The places a NEW tournament may offer on this server (2026-11-18): the largest power of two
 * not above MAX_ACTIVE_GAMES, between 4 and {@link MAX_CAPACITY}. A first round then needs at most
 * half the rooms the server can hold at once (16 -> 16 places, 32 -> 32, 64 -> 64), so a bracket
 * is never offered that the server cannot start. An existing bigger tournament is never shrunk.
 */
export function offeredCapacity(maxActiveGames: number): number {
    let places = 4;
    while (places * 2 <= maxActiveGames && places * 2 <= MAX_CAPACITY) places *= 2;
    return places;
}

let offered = offeredCapacity(16);

/** Set once at start from the server's MAX_ACTIVE_GAMES. */
export function configureOfferedCapacity(maxActiveGames: number): void {
    offered = offeredCapacity(maxActiveGames);
}

/** What the list and the detail say as `max_capacity`. */
export function offeredMax(): number {
    return offered;
}

/** A requested size for a new tournament, or for one whose current size is `current`: never
 *  above what the server offers, except that an existing tournament keeps its own size. */
export function clampOffered(raw: unknown, current = 0): number {
    return Math.min(Math.max(offered, current), clampCapacity(raw));
}
