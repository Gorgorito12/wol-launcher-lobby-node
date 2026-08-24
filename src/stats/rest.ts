import type { FastifyInstance } from 'fastify';
import { ipRateLimit, Limits } from '../middleware/rateLimit';
import { PROVISIONAL_RD, WIN_AT, LOSS_AT } from '../elo/ratability';
import type { AppContext } from '../context';

/**
 * Community stats: the ladder, and when people actually open rooms.
 *
 * ONE endpoint for both cards on purpose. They sit in the same strip, appear on
 * the same click, and the rate budget is per IP — shared by everyone behind the
 * same Radmin NAT — so two endpoints would cost exactly twice as much for no
 * benefit. `activity` is a second key in the same payload rather than a second
 * route, and a client that only knows about `leaderboard` keeps working.
 */

/** Fewest decided games before a player is ranked at all. Nearly implied by the
 *  deviation filter, but it also keeps the win-percentage column from being
 *  computed over a single game, where it can only read 0 % or 100 %. */
const MIN_DECIDED = 3;

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/** How far back the activity histogram looks. */
const ACTIVITY_WINDOW_DAYS = 30;

/** Server-side memo. The contents change at most once per finished match, and a
 *  minute of staleness on a decorative card is invisible; what it buys is that a
 *  roomful of players opening the tab together costs one query, not eight. */
const CACHE_TTL_MS = 60_000;
interface CacheEntry { at: number; limit: number; payload: unknown }
let cache: CacheEntry | null = null;

interface LeaderRow {
    id: string;
    discord_username: string;
    display_name: string;
    avatar_url: string | null;
    rating: number;
    rd: number;
    games_played: number;
    wins: number;
    losses: number;
}

interface HourRow { h: number; c: number }

export function registerStatsRest(app: FastifyInstance, ctx: AppContext): void {
    app.get('/stats/community', {
        preHandler: [ipRateLimit(ctx, Limits.StatsPublicIp)],
    }, async (req, reply) => {
        const raw = (req.query as { limit?: string } | undefined)?.limit;
        const parsed = raw ? parseInt(raw, 10) : DEFAULT_LIMIT;
        const limit = Number.isFinite(parsed)
            ? Math.min(MAX_LIMIT, Math.max(1, parsed))
            : DEFAULT_LIMIT;

        const now = Date.now();
        if (cache && cache.limit === limit && now - cache.at < CACHE_TTL_MS) {
            reply.header('Cache-Control', 'public, max-age=60');
            return cache.payload;
        }

        // The win/loss tally is a derived table joined with LEFT JOIN, so a player
        // with a rating but no decided games still appears here (and is then filtered
        // out by the HAVING-style predicate below) instead of vanishing silently.
        // SUM() over no rows is NULL, not 0 — hence the COALESCEs. And the aliases
        // cannot be used in WHERE, so the predicate repeats the expression.
        const rows = await ctx.db.prepare(
            `SELECT u.id, u.discord_username, u.display_name, u.avatar_url,
                    e.rating, e.rd, e.games_played,
                    COALESCE(w.wins, 0) AS wins, COALESCE(w.losses, 0) AS losses
             FROM elo_ratings e
             JOIN users u ON u.id = e.user_id
             LEFT JOIN (
                 SELECT user_id,
                        SUM(CASE WHEN result >= ? THEN 1 ELSE 0 END) AS wins,
                        SUM(CASE WHEN result <= ? THEN 1 ELSE 0 END) AS losses
                 FROM match_participants GROUP BY user_id
             ) w ON w.user_id = e.user_id
             WHERE e.mode = 'default'
               AND u.is_banned = 0
               AND e.rd <= ?
               AND (COALESCE(w.wins, 0) + COALESCE(w.losses, 0)) >= ?
             ORDER BY e.rating DESC
             LIMIT ?`,
        ).bind(WIN_AT, LOSS_AT, PROVISIONAL_RD, MIN_DECIDED, limit).all<LeaderRow>();

        // The rank is decided HERE, by the same ordering that produced the list. A
        // client filtering its copy must not renumber: the third row is the third
        // player, not the third thing that survived the client's own filter.
        const leaderboard = (rows.results ?? []).map((r, i) => ({
            rank: i + 1,
            user_id: r.id,
            discord_username: r.discord_username,
            display_name: r.display_name,
            avatar_url: r.avatar_url,
            rating: r.rating,
            rd: r.rd,
            games_played: r.games_played,
            wins: r.wins,
            losses: r.losses,
        }));

        // Source is lobbies.created_at, and the wording on the card has to match:
        // this is when people OPEN ROOMS, not when they play. Rooms are stamped by
        // the server (datetime('now'), UTC) and their rows are never deleted, while
        // matches.started_at is written by the client and only exists for the few
        // games that got reported at all.
        const hourRows = await ctx.db.prepare(
            `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS h, COUNT(*) AS c
             FROM lobbies
             WHERE created_at >= datetime('now', ?)
             GROUP BY h`,
        ).bind(`-${ACTIVITY_WINDOW_DAYS} days`).all<HourRow>();

        // All 24 buckets, always, zero-filled here. A gap in the array would leave
        // the client guessing whether it meant "nobody" or "not reported".
        const counts = new Array<number>(24).fill(0);
        let total = 0;
        for (const r of hourRows.results ?? []) {
            if (r.h >= 0 && r.h < 24) { counts[r.h] = r.c; total += r.c; }
        }

        const payload = {
            generated_at: new Date(now).toISOString(),
            min_decided: MIN_DECIDED,
            leaderboard,
            activity: {
                source: 'lobbies_created',
                window_days: ACTIVITY_WINDOW_DAYS,
                // UTC, and said out loud. The server has no idea where any given
                // player lives; the launcher knows its own offset and shifts the
                // buckets when it draws them.
                timezone: 'UTC',
                total,
                hours: counts.map((c, h) => ({ hour: h, count: c })),
            },
        };

        cache = { at: now, limit, payload };
        reply.header('Cache-Control', 'public, max-age=60');
        return payload;
    });
}
