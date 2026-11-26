/**
 * What a match must be to count toward a medal, and how much farming a medal tolerates.
 *
 * <p>Medals are positive-sum where the rating is zero-sum: two friends trading wins move each
 * other's rating nowhere, but each collects a "win 50" in half the time. So medals carry their
 * own limits on top of the ELO's discount ({@link MEDAL_MIN_ELO_FACTOR},
 * {@link MEDAL_WINS_PER_RIVAL_PER_DAY}). A win that fails them simply does not count: it neither
 * advances a medal nor breaks a streak.</p>
 *
 * <p>Casual matches count for the general medals (played, won, civilizations, maps, room rules —
 * treaties and King of the Hill only exist in casual rooms). Their result is the host's word, so
 * {@link isCountable} adds the checks the rating engine skips for them: a room, everybody in it,
 * and a real length.</p>
 */
import { WIN_AT, LOSS_AT } from '../elo/ratability';

export { WIN_AT, LOSS_AT };

/** A match shorter than this counts for nothing: the same floor the rating uses (ratability.ts). */
export const MEDAL_MIN_DURATION_SECONDS = 180;

/** A rated win the ELO discounted below this factor (a pair's 8th win in a row) earns no medal. */
export const MEDAL_MIN_ELO_FACTOR = 0.5;

/** At most this many wins a UTC day against the same opposing side count toward medals. */
export const MEDAL_WINS_PER_RIVAL_PER_DAY = 3;

/** Ages and the podium are only medals on a table at least this big: #1 of 1 is not a feat. */
export const MIN_LADDER_FOR_POSITION_MEDALS = 10;

/** A tournament must have had at least this many games actually played to give Champion/Organiser. */
export const TOURNAMENT_MIN_PLAYED = 3;

/** The duration medals ignore matches decided without the game reaching its end on its own. */
export const DURATION_UNTRUSTED_DECIDERS: ReadonlySet<string> = new Set(['abandon', 'founded', 'operator']);

/**
 * Why an unrated match still counts. Everything else unrated — a crash void, a duplicate
 * recording, an implausible clock, a contradicted founding, a new account's short game, an
 * operator void — counts for nothing.
 */
export const COUNTABLE_UNRATED: ReadonlySet<string> = new Set([
    'not_competitive', 'mod_not_ranked', 'not_1v1', 'no_decided_result', 'teams_mismatch',
]);

export interface CountableFacts {
    lobbyId: string | null;
    durationSeconds: number | null;
    /** Every participant of the match was in the room when it started (or the room predates the roster). */
    rosterOk: boolean;
    rated: number | null;
    unratedReason: string | null;
}

/** Whether a stored match counts toward medals at all. */
export function isCountable(m: CountableFacts): boolean {
    if (!m.lobbyId) return false;
    if (m.durationSeconds === null || !(m.durationSeconds >= MEDAL_MIN_DURATION_SECONDS)) return false;
    if (!m.rosterOk) return false;
    if (m.rated === 1) return true;
    return m.unratedReason !== null && COUNTABLE_UNRATED.has(m.unratedReason);
}

/** A rated win the ELO itself discounted too far. NULL factor = rated before the discount existed. */
export function eloAllowsMedal(rated: number | null, eloFactor: number | null): boolean {
    return rated !== 1 || eloFactor === null || eloFactor >= MEDAL_MIN_ELO_FACTOR;
}

/** "2026-11-21" for an epoch ms, the day the per-rival cap is counted in. */
export function utcDay(atMs: number): string {
    return new Date(atMs).toISOString().slice(0, 10);
}
