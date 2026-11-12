/**
 * Streaks: wins in a row on one ladder.
 *
 * <p>A run of wins is broken by a loss, a draw, or more than {@link STREAK_IDLE_CUTOFF_MS} (14
 * days) between two rated matches. Runs of losses are counted the same way, with a win breaking
 * them, so "longest win streak" and "longest losing streak" are the same kind of thing.</p>
 *
 * <p>The CURRENT streak is also cut by the clock: once fourteen days pass after the last rated
 * match, it is 0, and `endedAt` says when it ended (that last match plus fourteen days) so the
 * launcher can say "it ended on 18 Sep: 14 days without playing". A streak cut by a loss has no
 * `endedAt`: the loss is right there in the History.</p>
 *
 * <p>Pure, computed on read from the player's rated matches. There is no timer: a streak that
 * expires simply reads as expired the next time somebody asks.</p>
 */
import { WIN_AT, LOSS_AT } from './ratability';

export const STREAK_IDLE_CUTOFF_MS = 14 * 24 * 60 * 60 * 1000;

export interface StreakRow {
    atMs: number;
    result: number;
}

export interface StreakSummary {
    /** Wins in a row right now. 0 after a loss, or once fourteen days have passed. */
    current: number;
    /** The longest run of wins ever. */
    best: number;
    /** The longest run of losses ever. */
    lossBest: number;
    /** When the current streak expired for inactivity, as epoch ms; null otherwise. */
    endedAt: number | null;
}

/** Rows oldest first. */
export function streakSummary(rows: readonly StreakRow[], nowMs: number): StreakSummary {
    let win = 0;
    let loss = 0;
    let best = 0;
    let lossBest = 0;
    let lastAt: number | null = null;
    for (const r of rows) {
        if (lastAt !== null && r.atMs - lastAt > STREAK_IDLE_CUTOFF_MS) {
            win = 0;
            loss = 0;
        }
        if (r.result >= WIN_AT) {
            win += 1;
            loss = 0;
        } else if (r.result <= LOSS_AT) {
            loss += 1;
            win = 0;
        } else {
            win = 0;
            loss = 0;
        }
        if (win > best) best = win;
        if (loss > lossBest) lossBest = loss;
        lastAt = r.atMs;
    }

    let current = win;
    let endedAt: number | null = null;
    if (lastAt !== null && current > 0 && nowMs - lastAt > STREAK_IDLE_CUTOFF_MS) {
        endedAt = lastAt + STREAK_IDLE_CUTOFF_MS;
        current = 0;
    }
    return { current, best, lossBest, endedAt };
}

/**
 * The longest run of wins inside a window, counting only matches inside it. A run that started
 * before the window counts from its first win inside it: "the best streak of the month" is about
 * the month.
 */
export function bestWinRunWithin(rows: readonly StreakRow[], fromMs: number, toMs: number): number {
    let win = 0;
    let best = 0;
    let lastAt: number | null = null;
    for (const r of rows) {
        if (r.atMs < fromMs || r.atMs >= toMs) continue;
        if (lastAt !== null && r.atMs - lastAt > STREAK_IDLE_CUTOFF_MS) win = 0;
        win = r.result >= WIN_AT ? win + 1 : 0;
        if (win > best) best = win;
        lastAt = r.atMs;
    }
    return best;
}
