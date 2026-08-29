/**
 * Reading SQLite's own timestamps back as instants.
 *
 * <p>`datetime('now')` yields `'YYYY-MM-DD HH:MM:SS'` in UTC with <b>no zone marker</b>,
 * and `Date.parse` reads exactly that shape as LOCAL time. On a server running anywhere
 * but UTC every such value silently drifts by the host's offset — which for a rule like
 * "has this socket been gone ninety seconds" is the difference between a forfeit and a
 * hiccup.</p>
 *
 * <p>This started as a private helper in discordAnnounce.ts, where getting it wrong made
 * the embed's "Opened 5 minutes ago" wrong by hours. It is shared now because a second
 * caller appeared, and two copies of a rule is how they come to disagree.</p>
 */

/** ISO-8601 UTC for a SQLite timestamp. An already-ISO value passes through unchanged. */
export function normaliseSqliteTimestamp(ts: string): string {
    if (!ts) return new Date().toISOString();
    if (ts.includes('T')) return ts;
    return `${ts.replace(' ', 'T')}Z`;
}

/** Milliseconds since the epoch, or null when the value is missing or unparseable. */
export function sqliteTimestampToMs(ts: string | null | undefined): number | null {
    if (!ts) return null;
    const ms = Date.parse(normaliseSqliteTimestamp(ts));
    return Number.isFinite(ms) ? ms : null;
}
