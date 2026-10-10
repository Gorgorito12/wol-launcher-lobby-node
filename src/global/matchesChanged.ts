/**
 * The `matches_changed` frame: "a match was stored, or its result or rating changed", sent to
 * EVERY connected launcher so the pages built from the community's matches (the Rooms block, the
 * ranking and its match list, Ranking › Matches, the statistics, a player's history) refresh when
 * something actually happened instead of once a minute — or, for most of them, never until the
 * player switched tabs.
 *
 * Batched: one report can be followed within a second by its late rating and a civilization
 * filled in from a confirmation, and every launcher answering each of those separately would be
 * three bursts of requests for one match. The ids are collected and sent together.
 *
 * The frame names ids only. What changed is for the launcher to fetch; the user ids are there so
 * a player whose OWN match changed can also refresh their history and standing, which nobody
 * else needs.
 */

export interface MatchesChangedFrame {
    type: 'matches_changed';
    matchIds: string[];
    userIds: string[];
}

export type Schedule = (fn: () => void, ms: number) => unknown;

export class MatchesChangedBatcher {
    private readonly matchIds = new Set<string>();
    private readonly userIds = new Set<string>();
    private pending = false;

    constructor(
        private readonly send: (frame: MatchesChangedFrame) => void,
        private readonly delayMs = 1000,
        private readonly schedule: Schedule = (fn, ms) => setTimeout(fn, ms),
    ) {}

    /**
     * Note that `matchId` changed. The first note schedules the frame; notes that land before it
     * goes join it rather than delaying it, so a burst cannot postpone the frame indefinitely.
     */
    add(matchId: string, userIds: readonly string[]): void {
        if (matchId) this.matchIds.add(matchId);
        for (const id of userIds) if (id) this.userIds.add(id);
        if (this.pending || this.matchIds.size === 0) return;
        this.pending = true;
        this.schedule(() => this.flush(), this.delayMs);
    }

    /** Send what was collected. Never throws: an announcement must not break a report. */
    flush(): void {
        this.pending = false;
        if (this.matchIds.size === 0) return;
        const frame: MatchesChangedFrame = {
            type: 'matches_changed',
            matchIds: [...this.matchIds],
            userIds: [...this.userIds],
        };
        this.matchIds.clear();
        this.userIds.clear();
        try { this.send(frame); } catch { /* best-effort */ }
    }
}
