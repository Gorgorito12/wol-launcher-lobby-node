/**
 * Finding a player by name — what inviting somebody to a TEAM, or naming them in a line-up,
 * needs when they are not online.
 *
 * <p>The launcher's only other list of people is the presence panel, which is everybody
 * connected right now. That is the right list for a room invite, which is gone in minutes, and
 * the wrong one for a team: inviting somebody who is at work is the normal case, which is why a
 * team invitation is a row and not a socket frame (src/teams/rest.ts).</p>
 *
 * <p><b>Small on purpose.</b> At most {@link SEARCH_LIMIT} results, a name fragment of at least
 * two characters, banned accounts and the caller left out, and nothing but the name and the
 * avatar returned — the same two things the Players panel already shows about anybody online.
 * It is behind sign-in and its own rate limit, so it cannot be walked to list the user table.</p>
 *
 * <p>The query is pure here and pinned by a test; the route is in src/users/rest.ts.</p>
 */
import { likePattern } from '../matches/browse';

export const SEARCH_QUERY_MIN = 2;
export const SEARCH_QUERY_MAX = 32;
export const SEARCH_LIMIT = 10;

/** The fragment to look for, trimmed and capped, or null when it is too short to mean anything. */
export function parseSearchQuery(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (text.length < SEARCH_QUERY_MIN) return null;
    return text.slice(0, SEARCH_QUERY_MAX);
}

export const USER_SEARCH_SQL =
    `SELECT id AS user_id, display_name, avatar_url
       FROM users
      WHERE is_banned = 0
        AND id <> ?
        AND (display_name LIKE ? ESCAPE '\\' OR discord_username LIKE ? ESCAPE '\\')
      ORDER BY display_name COLLATE NOCASE
      LIMIT ${SEARCH_LIMIT}`;

/** The parameters for {@link USER_SEARCH_SQL}, in order. */
export function userSearchParams(callerId: string, query: string): string[] {
    const pattern = likePattern(query);
    return [callerId, pattern, pattern];
}
