/**
 * The door through which a ROOM asks the matches module to found the match nobody reported.
 *
 * <p>Same shape as `attachGlobalChat` in LobbyRoom.ts, and for the same reason: the room
 * code (`lobbies/LobbyRoom.ts`, `lobbies/rest.ts`, `lobbies/orphanSweep.ts`) must not import
 * `matches/rest.ts` — that file already imports from the lobbies side, and a cycle between
 * the two is the kind that works until the day it does not. `registerMatchesRest` installs
 * the real thing at startup; before it does, and in a test that never mounts the routes, the
 * hook is a no-op.</p>
 *
 * <p>Fire-and-forget by contract. Every caller is on a path that must not wait — a socket's
 * close handler, a REST reply — and founding is best-effort: a failure leaves the readings
 * where they were for the next hook to try.</p>
 */
let s_found: ((lobbyId: string) => Promise<void>) | null = null;

export function attachFoundingHook(fn: (lobbyId: string) => Promise<void>): void {
    s_found = fn;
}

/** Ask for the room's match to be founded, if it can be. Never throws, never waits. */
export function runFoundingHook(lobbyId: string): void {
    const fn = s_found;
    if (!fn) return;
    void fn(lobbyId).catch(() => { /* logged inside; a hook must not surface */ });
}
