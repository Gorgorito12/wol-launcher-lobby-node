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
 * is reading it, and an offset would hand them the same match twice on the next page. Newest
 * first by default; `sort=oldest` reverses it, and the cursor remembers which order issued it.
 */

export const BROWSE_DEFAULT_LIMIT = 30;
export const BROWSE_MAX_LIMIT = 50;
export const BROWSE_QUERY_MIN = 2;
export const BROWSE_QUERY_MAX = 32;
/** The only period windows the list accepts, in days. Anything else means "any date". */
export const BROWSE_DAYS = [1, 7, 30] as const;
/**
 * What this server can filter by beyond the search, the replay chip and the mod. Sent on every
 * page so a launcher can tell this server from an older one: an older one would IGNORE the
 * parameters and hand back the whole list while the launcher claimed to be filtering it.
 */
export const BROWSE_FILTERS = ['sort', 'days', 'kind', 'decided'] as const;

export type BrowseSort = 'newest' | 'oldest';
export type BrowseKind = 'competitive' | 'casual';

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
    /** Newest first unless the caller asked otherwise. The cursor carries its own direction. */
    sort: BrowseSort;
    /** A window ending now, in days; null for any date. Relative, so it needs no time zone. */
    days: (typeof BROWSE_DAYS)[number] | null;
    /**
     * The room's kind, from `lobbies.competitive`. A match whose lobby row is gone has no kind
     * and is in NEITHER filter: calling an unknown room casual is the mistake the launcher's
     * mode label refuses to make, and the filter must not make it either.
     */
    kind: BrowseKind | null;
    /** Only matches somebody won: a participant scored 1.0. A 0.5 is "could not be read". */
    decided: boolean;
}

// `datetime('now')` text, which is what every row carries; the ISO spelling is tolerated so a
// row written by a seed script cannot turn the page after it into a 400.
const SQLITE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z?$/;
const MATCH_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * `created_at|id` as base64url — opaque to the client, which only ever hands it back. An
 * oldest-first cursor carries a third `asc` segment: the same position read in the other
 * direction would skip or repeat matches, so a cursor is bound to the order that issued it.
 * Newest-first keeps the two-part form, so every cursor issued before sorting existed still works.
 */
export function encodeCursor(createdAt: string, id: string, ascending = false): string {
    const text = ascending ? `${createdAt}|${id}|asc` : `${createdAt}|${id}`;
    return Buffer.from(text, 'utf8').toString('base64url');
}

/**
 * The cursor a previous page returned, for the order it is being used with. Anything else —
 * including a cursor issued for the OTHER order — is a 400, never a silent first page.
 */
export function decodeCursor(raw: string, ascending = false): BrowseCursor {
    const bad = () => new HttpError(400, 'bad_cursor', 'This page cursor is not one the server issued.');
    if (raw.length === 0 || raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw bad();
    const parts = Buffer.from(raw, 'base64url').toString('utf8').split('|');
    if (parts.length < 2 || parts.length > 3) throw bad();
    const [createdAt, id, marker] = parts;
    if (!SQLITE_TIMESTAMP.test(createdAt) || !MATCH_ID.test(id)) throw bad();
    if (parts.length === 3 && marker !== 'asc') throw bad();
    if ((parts.length === 3) !== ascending) throw bad();
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

    // Read before the cursor: a cursor is only valid for the order that issued it.
    const sort: BrowseSort = q.sort === 'oldest' ? 'oldest' : 'newest';
    const cursor = typeof q.cursor === 'string' && q.cursor.length > 0
        ? decodeCursor(q.cursor, sort === 'oldest')
        : null;

    // Control characters out, whitespace collapsed: the text is matched against display names,
    // and a stray tab pasted from Discord should not turn a search into "no results".
    const text = typeof q.q === 'string'
        ? q.q.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
        : '';
    const search = text.length >= BROWSE_QUERY_MIN ? text.slice(0, BROWSE_QUERY_MAX) : null;

    const replayOnly = q.replay === '1' || q.replay === 'true';
    const mod = typeof q.mod === 'string' && q.mod.trim() ? q.mod.trim().slice(0, 64) : null;

    const d = typeof q.days === 'string' ? Number.parseInt(q.days, 10) : Number.NaN;
    const days = (BROWSE_DAYS as readonly number[]).includes(d) ? d as BrowseFilters['days'] : null;
    const kind: BrowseKind | null = q.kind === 'competitive' || q.kind === 'casual' ? q.kind : null;
    const decided = q.decided === '1' || q.decided === 'true';

    return { limit, cursor, q: search, replayOnly, mod, sort, days, kind, decided };
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
    if (f.kind) {
        // Explicit on both sides: a match whose lobby is gone reads NULL and belongs to neither.
        clauses.push(f.kind === 'competitive' ? 'l.competitive = 1' : 'l.competitive = 0');
    }
    if (f.days) {
        clauses.push(`m.created_at >= datetime('now', ?)`);
        params.push(`-${f.days} days`);
    }
    if (f.decided) {
        clauses.push(`EXISTS (SELECT 1 FROM match_participants p
                               WHERE p.match_id = m.id AND p.result = 1.0)`);
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
        clauses.push(f.sort === 'oldest'
            ? '(m.created_at > ? OR (m.created_at = ? AND m.id > ?))'
            : '(m.created_at < ? OR (m.created_at = ? AND m.id < ?))');
        params.push(f.cursor.createdAt, f.cursor.createdAt, f.cursor.id);
    }

    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** One page: the matches plus ONE more, which is how the route knows another page exists. */
export function browseSql(f: BrowseFilters): { sql: string; params: unknown[] } {
    const where = browseWhere(f, true);
    const dir = f.sort === 'oldest' ? 'ASC' : 'DESC';
    return {
        sql: `SELECT m.id, m.mod_id, m.map_name, m.duration_seconds,
                     m.created_at AS reported_at,
                     m.rated, m.unrated_reason,
                     l.competitive,
                     m.replay_key, m.replay_uploaded_at, m.replay_size_bytes
                FROM matches m
                LEFT JOIN lobbies l ON l.id = m.lobby_id
               ${where.sql}
               ORDER BY m.created_at ${dir}, m.id ${dir}
               LIMIT ?`,
        params: [...where.params, f.limit + 1],
    };
}

/** How many matches the whole list holds, for "Showing 30 of 412". Asked on the first page only. */
export function browseCountSql(f: BrowseFilters): { sql: string; params: unknown[] } {
    const where = browseWhere(f, false);
    // The kind reads the lobby, so the count joins it exactly as the page does; without a kind
    // there is nothing to join for.
    const join = f.kind ? ' LEFT JOIN lobbies l ON l.id = m.lobby_id' : '';
    return { sql: `SELECT COUNT(*) AS n FROM matches m${join} ${where.sql}`, params: where.params };
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
        const next_cursor = more && last
            ? encodeCursor(last.reported_at, last.id, filters.sort === 'oldest')
            : null;

        let total: number | undefined;
        if (!filters.cursor) {
            const count = browseCountSql(filters);
            const row = await ctx.db.prepare(count.sql).bind(...count.params).first<{ n: number }>();
            total = row?.n ?? 0;
        }

        // `filters` tells the launcher this server applies them; see BROWSE_FILTERS.
        const supported = [...BROWSE_FILTERS];
        return reply.send(total === undefined
            ? { items, next_cursor, filters: supported }
            : { items, next_cursor, total, filters: supported });
    });
}
