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
