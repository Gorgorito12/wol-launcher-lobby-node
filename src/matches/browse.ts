import type { FastifyInstance } from 'fastify';
import { HttpError } from '../lib/errors';
import { ipRateLimit, Limits } from '../middleware/rateLimit';
import { replayView } from '../replays/rules';
import { attachParticipants } from './rest';
import type { AppContext } from '../context';

/**
 * `GET /matches` — every community match, newest first, one page at a time.
 *
 * It exists so a recording can be FOUND for as long as it is kept: the "latest matches" panel
 * on the Ranking page shows the most recent thirty, and a competitive recording lives a year
 * (src/replays/rules.ts). Public like `/stats/community` — reading who played whom is not a
 * secret, and the download itself still needs a signed-in player.
 *
 * Paged by KEYSET (created_at, id), never by offset: the list grows at its head while somebody
 * is reading it, and an offset would hand them the same match twice on the next page.
 */

export const BROWSE_DEFAULT_LIMIT = 30;
export const BROWSE_MAX_LIMIT = 50;
export const BROWSE_QUERY_MIN = 2;
export const BROWSE_QUERY_MAX = 32;

export interface BrowseCursor {
    createdAt: string;
    id: string;
}

export interface BrowseFilters {
    limit: number;
    cursor: BrowseCursor | null;
    /** The player-name search, trimmed; null when absent or too short to mean anything. */
    q: string | null;
    replayOnly: boolean;
    mod: string | null;
}

// `datetime('now')` text, which is what every row carries; the ISO spelling is tolerated so a
// row written by a seed script cannot turn the page after it into a 400.
const SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z?$/;
const MATCH_ID = /^[A-Za-z0-9-]{1,64}$/;

/** `created_at|id` as base64url — opaque to the client, which only ever hands it back. */
export function encodeCursor(createdAt: string, id: string): string {
    return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

/** The cursor a previous page returned. Anything else is a 400, never a silent first page. */
export function decodeCursor(raw: string): BrowseCursor {
    const bad = () => new HttpError(400, 'bad_cursor', 'This page cursor is not one the server issued.');
    if (raw.length === 0 || raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw bad();
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    const bar = text.indexOf('|');
    if (bar < 0) throw bad();
    const createdAt = text.slice(0, bar);
    const id = text.slice(bar + 1);
    if (!SQLITE_TIMESTAMP.test(createdAt) || !MATCH_ID.test(id)) throw bad();
    return { createdAt, id };
}

/** A user's search as a LIKE pattern that matches it literally, anywhere in the name. */
export function likePattern(q: string): string {
    return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Every query parameter, read once. Unknown or malformed values fall back; a bad cursor does not. */
export function parseBrowseQuery(query: unknown): BrowseFilters {
    const q = (query ?? {}) as Record<string, unknown>;

    const n = typeof q.limit === 'string' ? Number.parseInt(q.limit, 10) : Number.NaN;
    const limit = Number.isFinite(n) ? Math.min(Math.max(n, 1), BROWSE_MAX_LIMIT) : BROWSE_DEFAULT_LIMIT;

    const cursor = typeof q.cursor === 'string' && q.cursor.length > 0 ? decodeCursor(q.cursor) : null;

    // Control characters out, whitespace collapsed: the text is matched against display names,
    // and a stray tab pasted from Discord should not turn a search into "no results".
    const text = typeof q.q === 'string'
        ? q.q.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
        : '';
    const search = text.length >= BROWSE_QUERY_MIN ? text.slice(0, BROWSE_QUERY_MAX) : null;

    const replayOnly = q.replay === '1' || q.replay === 'true';
    const mod = typeof q.mod === 'string' && q.mod.trim() ? q.mod.trim().slice(0, 64) : null;

    return { limit, cursor, q: search, replayOnly, mod };
}

/**
 * The WHERE clause and its parameters for a set of filters. `withCursor` is false for the
 * COUNT, which describes the whole list rather than what is left of it.
 */
export function browseWhere(f: BrowseFilters, withCursor: boolean): { sql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (f.mod) {
        clauses.push('m.mod_id = ?');
        params.push(f.mod);
    }
    if (f.replayOnly) {
        // The same year `replayView` counts. Past it the bucket has deleted the file, so a
        // match the filter returned would only ever offer "expired".
        clauses.push(`m.replay_key IS NOT NULL AND m.replay_uploaded_at > datetime('now', '-365 days')`);
    }
    if (f.q) {
        const like = likePattern(f.q);
        clauses.push(`EXISTS (SELECT 1 FROM match_participants mp
                               JOIN users u ON u.id = mp.user_id
                              WHERE mp.match_id = m.id
                                AND (u.display_name LIKE ? ESCAPE '\\' OR u.discord_username LIKE ? ESCAPE '\\'))`);
        params.push(like, like);
    }
    if (withCursor && f.cursor) {
        // `created_at` has one-second resolution, so two matches can share it; the id breaks
        // the tie the same way the ORDER BY does, or a page boundary could skip one of them.
        clauses.push('(m.created_at < ? OR (m.created_at = ? AND m.id < ?))');
        params.push(f.cursor.createdAt, f.cursor.createdAt, f.cursor.id);
    }

    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** One page: the matches plus ONE more, which is how the route knows another page exists. */
export function browseSql(f: BrowseFilters): { sql: string; params: unknown[] } {
    const where = browseWhere(f, true);
    return {
        sql: `SELECT m.id, m.mod_id, m.map_name, m.duration_seconds,
                     m.created_at AS reported_at,
                     m.rated, m.unrated_reason,
                     l.competitive,
                     m.replay_key, m.replay_uploaded_at, m.replay_size_bytes
                FROM matches m
                LEFT JOIN lobbies l ON l.id = m.lobby_id
               ${where.sql}
               ORDER BY m.created_at DESC, m.id DESC
               LIMIT ?`,
        params: [...where.params, f.limit + 1],
    };
}

/** How many matches the whole list holds, for "Showing 30 of 412". Asked on the first page only. */
export function browseCountSql(f: BrowseFilters): { sql: string; params: unknown[] } {
    const where = browseWhere(f, false);
    return { sql: `SELECT COUNT(*) AS n FROM matches m ${where.sql}`, params: where.params };
}

export function registerMatchesBrowse(app: FastifyInstance, ctx: AppContext): void {
    app.get('/matches', {
        preHandler: [ipRateLimit(ctx, Limits.MatchesBrowseIp)],
    }, async (req, reply) => {
        const filters = parseBrowseQuery(req.query);

        const page = browseSql(filters);
        const rows = await ctx.db.prepare(page.sql).bind(...page.params)
            .all<Record<string, unknown> & { id: string; reported_at: string }>();
        const found = rows.results ?? [];
        const more = found.length > filters.limit;
        const shown = more ? found.slice(0, filters.limit) : found;

        const now = new Date();
        // Same shape as `/stats/community`'s `recent_matches`, so the launcher draws one row
        // from both. Booleans are coerced for the reason given in /matches/history, and the
        // object key never leaves the server.
        const items = shown.map((m) => {
            const { replay_key, replay_uploaded_at, replay_size_bytes, ...rest } = m;
            return {
                ...rest,
                id: m.id,
                rated: m.rated == null ? null : Boolean(m.rated),
                competitive: m.competitive == null ? null : Boolean(m.competitive),
                ...replayView({
                    replay_key: replay_key as string | null,
                    replay_uploaded_at: replay_uploaded_at as string | null,
                    replay_size_bytes: replay_size_bytes as number | null,
                }, now),
            };
        });
        await attachParticipants(ctx, items);

        const last = shown[shown.length - 1];
        const next_cursor = more && last ? encodeCursor(last.reported_at, last.id) : null;

        let total: number | undefined;
        if (!filters.cursor) {
            const count = browseCountSql(filters);
            const row = await ctx.db.prepare(count.sql).bind(...count.params).first<{ n: number }>();
            total = row?.n ?? 0;
        }

        return reply.send(total === undefined ? { items, next_cursor } : { items, next_cursor, total });
    });
}
