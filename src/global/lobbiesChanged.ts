/**
 * The `lobbies_changed` frame (2026-11-11): "the list of rooms changed" - a room was created
 * (private ones too), closed, started, went back to its lobby, was renamed, or gained or lost a
 * player. Sent to EVERY connected launcher, with no data: a launcher whose Rooms page is on screen
 * asks `/lobbies` again, the others ignore it. Before it, a new room reached the Rooms page on the
 * next 5-second poll, and a closed one lingered just as long.
 *
 * Batched per second like `matches_changed`: a room filling up is several changes in a moment, and
 * every launcher answering each of them would be a burst of requests for one room. A burst cannot
 * postpone the frame: the first note schedules it, later ones join it.
 *
 * The rooms code reaches the socket through {@link noteLobbiesChanged}, a module-level hook the
 * global chat room installs, so `lobbies/` imports nothing from `global/` beyond this file - the
 * same reason `discordAnnounce` is configured once at startup instead of being handed a context.
 */

export interface LobbiesChangedFrame {
    type: 'lobbies_changed';
}

export type Schedule = (fn: () => void, ms: number) => unknown;

export class LobbiesChangedBatcher {
    private pending = false;

    constructor(
        private readonly send: (frame: LobbiesChangedFrame) => void,
        private readonly delayMs = 1000,
        private readonly schedule: Schedule = (fn, ms) => setTimeout(fn, ms),
    ) {}

    /** Note a change. The first note schedules the frame; the rest join it. */
    note(): void {
        if (this.pending) return;
        this.pending = true;
        this.schedule(() => this.flush(), this.delayMs);
    }

    /** Send it. Never throws: an announcement must not break a room. */
    flush(): void {
        if (!this.pending) return;
        this.pending = false;
        try { this.send({ type: 'lobbies_changed' }); } catch { /* best-effort */ }
    }
}

let sink: (() => void) | null = null;

/**
 * What must forget the old list when it changes - today the one-answer memo of GET /lobbies.
 * Without it the frame was worse than useless: the launchers it woke asked within half a second,
 * got the memo from before the change (up to 3 s old) and then waited for the next poll. Found
 * with two launchers against a local server: a quick match that should meet in ~2 s took 21.
 */
const forgetters = new Set<() => void>();

/** Register something that must drop a cached list whenever the rooms change. */
export function onLobbiesChanged(forget: () => void): void {
    forgetters.add(forget);
}

/** Run every forgetter. Never throws. */
export function forgetLobbyLists(): void {
    for (const forget of forgetters) {
        try { forget(); } catch { /* a cache must never break a room */ }
    }
}

/** Installed once by the global chat room. */
export function setLobbiesChangedSink(fn: (() => void) | null): void {
    sink = fn;
}

/**
 * Called by the rooms code on every change a room list shows. Never throws. The cached list is
 * dropped now AND again when the frame goes out (the sink does that), so an answer cached between
 * the change and the frame is never what the woken launchers read.
 */
export function noteLobbiesChanged(): void {
    forgetLobbyLists();
    try { sink?.(); } catch { /* never break a room on an announcement */ }
}
