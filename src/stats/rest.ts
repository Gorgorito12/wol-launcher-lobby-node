import type { FastifyInstance } from 'fastify';
import { ipRateLimit, Limits } from '../middleware/rateLimit';
import { PROVISIONAL_RD, WIN_AT, LOSS_AT } from '../elo/ratability';
import { attachParticipants } from '../matches/rest';
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

/** How far back "players around" counts. Deliberately shorter than the 30-day room
 *  histogram: that one is about finding the hour people play at, which needs a month to
 *  say anything, while this one answers "is anyone here THESE days" and a month-old
 *  visitor is not an answer to that. */
const ACTIVE_PLAYERS_WINDOW_DAYS = 7;

/** How many finished matches the strip lists. Five is what fits the card without the
 *  panel growing into the room list above it. */
const RECENT_MATCHES_LIMIT = 5;

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

interface TotalsRow { matches: number; players: number }
interface TopMapRow { map_name: string; n: number }

/**
 * One ladder, ranked.
 *
 * <p>Extracted so the 1v1 and team tables cannot drift apart: they differ by the `mode`
 * they select and by nothing else, which is exactly the property that makes a second
 * ladder cheap.</p>
 *
 * <p><b>The win/loss tally is scoped to the same mode</b>, through `matches.rating_mode`.
 * It used to count every `match_participants` row a player had, which was harmless while
 * one ladder existed and would silently pad a player's 1v1 record with their team wins
 * the moment a second one did. NULL means a row written before migration 0010, all of
 * which were 1v1.</p>
 *
 * <p>The tally is a LEFT JOIN so a player with a rating but no decided games still
 * appears and is then filtered by the predicate, rather than vanishing for a reason the
 * query does not state. SUM() over no rows is NULL, not 0 — hence the COALESCEs — and
 * aliases cannot be used in WHERE, so the predicate repeats the expression.</p>
 */
async function ladder(ctx: AppContext, mode: 'default' | 'team', limit: number) {
    const rows = await ctx.db.prepare(
        `SELECT u.id, u.discord_username, u.display_name, u.avatar_url,
                e.rating, e.rd, e.games_played,
                COALESCE(w.wins, 0) AS wins, COALESCE(w.losses, 0) AS losses
         FROM elo_ratings e
         JOIN users u ON u.id = e.user_id
         LEFT JOIN (
             SELECT mp.user_id AS user_id,
                    SUM(CASE WHEN mp.result >= ? THEN 1 ELSE 0 END) AS wins,
                    SUM(CASE WHEN mp.result <= ? THEN 1 ELSE 0 END) AS losses
             FROM match_participants mp
             JOIN matches m ON m.id = mp.match_id
             WHERE COALESCE(m.rating_mode, 'default') = ?
             GROUP BY mp.user_id
         ) w ON w.user_id = e.user_id
         WHERE e.mode = ?
           AND u.is_banned = 0
           AND e.rd <= ?
           AND (COALESCE(w.wins, 0) + COALESCE(w.losses, 0)) >= ?
         ORDER BY e.rating DESC
         LIMIT ?`,
    ).bind(WIN_AT, LOSS_AT, mode, mode, PROVISIONAL_RD, MIN_DECIDED, limit).all<LeaderRow>();

    // The rank is decided HERE, by the same ordering that produced the list. A client
    // filtering its copy must not renumber: the third row is the third player, not the
    // third thing that survived the client's own filter.
    return (rows.results ?? []).map((r, i) => ({
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
}

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

        // Both ladders, one round trip each, inside the SAME cached payload. Rule (10)
        // of the multiplayer notes: the community strip is one endpoint, because the
        // request budget is per IP and shared behind a Radmin NAT — a second route would
        // cost double for a page nobody asked twice for.
        const [leaderboard, leaderboard_team] = await Promise.all([
            ladder(ctx, 'default', limit),
            ladder(ctx, 'team', limit),
        ]);

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

        // Two scalars in one round trip, the pattern /quota already uses.
        //
        // Both windows are measured against SERVER-stamped columns. matches.created_at is
        // the DEFAULT datetime('now') written when the report lands; matches.started_at is
        // sent by the client and would let one wrong clock skew the count — the same
        // reasoning that makes the histogram above read lobbies.created_at rather than
        // anything a launcher reports. It costs a scan of `matches` (created_at is not
        // indexed), which is no worse than the histogram's scan of `lobbies`.
        const totals = await ctx.db.prepare(
            `SELECT
                (SELECT COUNT(*) FROM matches
                  WHERE created_at >= datetime('now', ?))    AS matches,
                (SELECT COUNT(*) FROM users
                  WHERE last_seen_at >= datetime('now', ?))  AS players`,
        ).bind(
            `-${ACTIVITY_WINDOW_DAYS} days`,
            `-${ACTIVE_PLAYERS_WINDOW_DAYS} days`,
        ).first<TotalsRow>();

        // The tiebreak is not decoration: with two maps on the same count the winner would
        // otherwise change between one request and the next, and a card that reports a
        // different favourite map every minute is worse than one that reports none.
        const topMap = await ctx.db.prepare(
            `SELECT map_name, COUNT(*) AS n
               FROM matches
              WHERE map_name IS NOT NULL AND map_name <> ''
                AND created_at >= datetime('now', ?)
              GROUP BY map_name
              ORDER BY n DESC, map_name ASC
              LIMIT 1`,
        ).bind(`-${ACTIVITY_WINDOW_DAYS} days`).first<TopMapRow>();

        // The community's last few matches — everyone's, not the caller's. The strip is
        // headed "community activity" and used to fill this from the viewer's own history,
        // so a player who had never played saw an empty panel with nothing to suggest
        // anyone else was here.
        const recentRows = await ctx.db.prepare(
            `SELECT id, mod_id, map_name, duration_seconds,
                    created_at AS reported_at
               FROM matches
              ORDER BY created_at DESC
              LIMIT ?`,
        ).bind(RECENT_MATCHES_LIMIT).all<Record<string, unknown> & { id: string }>();

        const recent_matches = recentRows.results ?? [];
        // The same helper the history endpoint uses, so "who played" is assembled one way
        // in this codebase: one query for the whole page, never one per match.
        await attachParticipants(ctx, recent_matches);

        const payload = {
            generated_at: new Date(now).toISOString(),
            min_decided: MIN_DECIDED,
            leaderboard,
            // The team ladder rides the same payload. An older launcher ignores the extra
            // field; a newer one against an older server deserializes it to null, which it
            // reads as "this backend has no team ladder" rather than as an empty one.
            leaderboard_team,
            totals: {
                window_days: ACTIVITY_WINDOW_DAYS,
                matches: totals?.matches ?? 0,
                players_window_days: ACTIVE_PLAYERS_WINDOW_DAYS,
                players: totals?.players ?? 0,
                // null, never "" — the client shows the row only when there IS a map, and
                // an empty string would render as a blank value under a live heading.
                top_map: topMap?.map_name ?? null,
                top_map_matches: topMap?.n ?? 0,
            },
            recent_matches,
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
