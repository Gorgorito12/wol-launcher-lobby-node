/**
 * Rating seasons — the calendar, and the soft reset a player carries into a new one.
 *
 * <p><b>A season is a pure function of time.</b> Nothing flips it, nothing schedules it, and
 * this server must not grow a timer for it (src/tournaments/lifecycle.ts says why there is
 * none). Ratings are keyed by `(user_id, mode, season)` in `season_ratings`, so a season that
 * has just begun simply has no rows yet: that absence IS the reset, and it happens at the
 * boundary instant on every reader at once.</p>
 *
 * <p><b>The calendar.</b> Everything stored before {@link SEASON_2_START} is Season 1 — the
 * ratings that existed when seasons were introduced, copied in by migration 0024. From there a
 * season lasts {@link SEASON_MONTHS} calendar months: Dec-Feb, Mar-May, Jun-Aug, Sep-Nov. Every
 * boundary is the 1st of the month at the same UTC hour, 06:00 — midnight in Central America
 * and Mexico City, and already that day everywhere in Latin America (03:00 in Argentina) and in
 * Spain (07:00).</p>
 *
 * <p><b>A match belongs to the season of `matches.created_at`</b> — the server's own stamp,
 * written by the DEFAULT `datetime('now')` when the row is inserted and never updated. Never a
 * client clock, and never the moment a match happens to be RATED: a team match stored at 05:58
 * and corroborated at 06:02 is a Season-N match whose rating arrived after Season N closed.</p>
 *
 * <p>Everything here takes its clock from the caller, like ratability.ts and founding.ts, so the
 * boundary is testable to the second.</p>
 */
import { sqliteTimestampToMs } from '../lib/time';

/** The first instant of Season 2: 1 Dec 2026, 06:00 UTC. Season 1 is everything before it. */
export const SEASON_2_START = Date.UTC(2026, 11, 1, 6, 0, 0);

/** How long a season lasts, in calendar months. */
export const SEASON_MONTHS = 3;

/** The season Season 1's ratings were copied into. */
export const FIRST_SEASON = 1;

/**
 * How much of the gap to 1500 a player keeps across a reset. One half: a 2000 starts the next
 * season at 1750 and a 1300 at 1400, so a strong player regains his level in a handful of
 * matches while the table still starts level enough for newcomers to climb it.
 */
export const SOFT_RESET_KEEP = 0.5;

/**
 * The least deviation anybody carries into a new season. 250 is what Glicko-2 reaches after
 * about two matches, so the first matches of a season move a rating by roughly ±90 — enough
 * for a player to find his level again quickly, not enough to turn one lucky night into a
 * place at the top.
 */
export const SOFT_RESET_MIN_RD = 250;

/** The rating the soft reset pulls everybody towards: Glicko-2's starting point. */
const RESET_CENTRE = 1500;

/** The first instant of season `n`, in epoch milliseconds. Season 1 has no start. */
export function seasonStartMs(n: number): number {
    if (n <= FIRST_SEASON) return Number.NEGATIVE_INFINITY;
    const d = new Date(SEASON_2_START);
    // Date.UTC normalises an overflowing month (14 → March of the next year), which is the
    // whole of the calendar arithmetic.
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + SEASON_MONTHS * (n - 2), 1,
        d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

/** The first instant AFTER season `n`, i.e. the start of season `n + 1`. */
export function seasonEndMs(n: number): number {
    return seasonStartMs(Math.max(FIRST_SEASON, n) + 1);
}

/** Season `n`'s bounds: `start` inclusive (null for Season 1), `end` exclusive. */
export function seasonBounds(n: number): { start: number | null; end: number } {
    const start = seasonStartMs(n);
    return { start: Number.isFinite(start) ? start : null, end: seasonEndMs(n) };
}

/** The season an instant belongs to. Anything before Season 2 is Season 1. */
export function seasonAt(ms: number): number {
    if (!Number.isFinite(ms) || ms < SEASON_2_START) return FIRST_SEASON;
    const s = new Date(SEASON_2_START);
    const t = new Date(ms);
    const months = (t.getUTCFullYear() - s.getUTCFullYear()) * 12
        + (t.getUTCMonth() - s.getUTCMonth());
    // Inside a boundary month but before the boundary hour (the 1st, before 06:00) the
    // previous season is still running.
    let n = 2 + Math.floor(months / SEASON_MONTHS);
    while (n > FIRST_SEASON && ms < seasonStartMs(n)) n--;
    while (ms >= seasonStartMs(n + 1)) n++;
    return n;
}

/** The season running at `nowMs`. */
export function currentSeason(nowMs: number): number {
    return seasonAt(nowMs);
}

/** Whether season `n` has ended at `nowMs`. There is no grace: it ends at its boundary. */
export function isClosed(n: number, nowMs: number): boolean {
    return nowMs >= seasonEndMs(n);
}

/**
 * The season a stored row belongs to, from its SQLite `created_at` text. A value that cannot
 * be read lands in Season 1 rather than in the current one: it can only be an old row, and the
 * current season is the one place a misfiled row would move somebody's rating today.
 */
export function seasonOfCreatedAt(sql: string | null | undefined): number {
    const ms = sqliteTimestampToMs(sql);
    return ms === null ? FIRST_SEASON : seasonAt(ms);
}

/**
 * An epoch instant as SQLite writes `datetime('now')`: `'YYYY-MM-DD HH:MM:SS'`, UTC, no zone.
 *
 * <p><b>Season bounds are compared as TEXT against `matches.created_at`</b>, which is only
 * correct because both inserts into `matches` leave that column to its DEFAULT — a test scans
 * the source to keep it that way. An ISO value with a `T` would sort after every space-form
 * value of the same day whatever its time, and a match would silently land in the wrong
 * season.</p>
 */
export function toSqliteText(ms: number): string {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/** Season `n`'s bounds as SQLite text, for `created_at >= ? AND created_at < ?`. */
export function boundsAsSql(n: number): { start: string | null; end: string } {
    const b = seasonBounds(n);
    return { start: b.start === null ? null : toSqliteText(b.start), end: toSqliteText(b.end) };
}

/**
 * The bindable predicate for "stored during season `n`" over a `created_at` column. Season 1
 * has no lower bound; every season has an upper one.
 */
export function seasonPredicate(n: number, column = 'created_at'): { sql: string; args: string[] } {
    const b = boundsAsSql(n);
    return b.start === null
        ? { sql: `${column} < ?`, args: [b.end] }
        : { sql: `${column} >= ? AND ${column} < ?`, args: [b.start, b.end] };
}

/** A season's starting point for a player, from where he finished his last played one. */
export interface CarriedRating {
    rating: number;
    rd: number;
    volatility: number;
}

/**
 * The soft reset: halfway back to 1500, with at least {@link SOFT_RESET_MIN_RD} of deviation,
 * volatility kept. Games are not carried — a season's `games_played` counts that season.
 */
export function softReset(row: CarriedRating): CarriedRating {
    return {
        rating: RESET_CENTRE + SOFT_RESET_KEEP * (row.rating - RESET_CENTRE),
        rd: Math.max(row.rd, SOFT_RESET_MIN_RD),
        volatility: row.volatility,
    };
}

/** Every season from 1 to the current one, oldest first, as the launcher lists them. */
export function seasonList(nowMs: number): Array<{
    n: number; starts_at: string | null; ends_at: string; closed: boolean;
}> {
    const current = currentSeason(nowMs);
    const out = [];
    for (let n = FIRST_SEASON; n <= current; n++) {
        const b = seasonBounds(n);
        out.push({
            n,
            starts_at: b.start === null ? null : new Date(b.start).toISOString(),
            ends_at: new Date(b.end).toISOString(),
            closed: isClosed(n, nowMs),
        });
    }
    return out;
}
