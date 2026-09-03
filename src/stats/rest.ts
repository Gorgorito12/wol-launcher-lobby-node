import type { FastifyInstance } from 'fastify';
import { ipRateLimit, userRateLimit, Limits } from '../middleware/rateLimit';
import { requireAuth } from '../middleware/auth';
import { Errors } from '../lib/errors';
import { WIN_AT, LOSS_AT } from '../elo/ratability';
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

/**
 * Fewest RATED games before a player is on the table. One: the table lists the best by
 * rating, and anybody whose rating has moved has a rating worth listing.
 *
 * <p>It used to be 3, alongside a `rd <= 110` filter, and TOGETHER they left the table empty
 * for a community that had been playing for weeks. The deviation was the one doing it: each
 * match is its own Glicko rating period, so RD falls slowly — measured against the library
 * this repo installs, 290 / 256 / 230 after one, two and three matches, first crossing 110
 * around the FOURTEENTH, and never at all for a player who keeps winning, because a growing
 * rating re-inflates RD as fast as the update shrinks it. The best player in the community
 * was the one who could never appear.</p>
 *
 * <p>The comment here used to say the games bar was "nearly implied by the deviation filter".
 * It was the other way round: the deviation was about five times stricter, and the payload
 * advertised only this weaker number, which is why the launcher's empty-state promised entry
 * at three matches while something else was refusing everybody.</p>
 *
 * <p>What replaced it is `e.games_played >= MIN_DECIDED`, a column `applyMatch` already
 * maintains — so it counts RATED matches only, and no subquery decides who is eligible. The
 * win/loss tally below stays, but purely to fill the DECIDED column.</p>
 *
 * <p><b>Raised to 5, and it is NOT what fixes the newcomer problem — the ORDER BY is.</b> The
 * complaint was a player sitting first with three rated matches above one with thirteen, and
 * measured against the live table a threshold could not answer it: he had exactly 3, so a bar
 * of 3 still crowned him, and a bar of 5 left the whole table with TWO names. This is a floor
 * against a lucky first night, nothing more; the confidence-adjusted ordering below is the
 * mechanism. Keep it low for the same reason it was lowered before — this community plays
 * about 35 rated matches a month, and a table nobody is on teaches nobody anything.</p>
 */
export const MIN_DECIDED = 5;

/**
 * How good a player is AT LEAST — Glicko-2's conservative estimate, the number the ladder is
 * ordered by. Exported as BOTH the SQL fragment and the same arithmetic in JS so the query and
 * the test that pins it cannot drift apart; the string is a module constant, never user input.
 *
 * <p>Two, not one: measured on the live table, a single deviation still put the three-match
 * player second instead of third. Two is also what Glicko-2's own write-up recommends.</p>
 */
export const LADDER_ORDER_BY = '(e.rating - 2 * e.rd) DESC';

/**
 * Who is on a ladder at all. SHARED, not copied, by the list and by the count of it.
 *
 * <p>A count that filtered differently from the list it describes would be worse than no
 * count: it would put somebody at "7 of 18" in a table showing 20 names, and the disagreement
 * would be invisible from either side. Two queries spelling out the same three conditions is
 * exactly the shape that drifts, so there is one string and both interpolate it.</p>
 *
 * <p>The bound parameters are positional, so a caller must bind mode then MIN_DECIDED in that
 * order, after whatever its own SELECT needs.</p>
 */
export const LADDER_WHERE = `WHERE e.mode = ?
           AND u.is_banned = 0
           AND e.games_played >= ?`;

/**
 * Civilization against civilization, in rated 1v1s. The table a modder balances from: a civ's
 * overall win rate says it is strong, this says what it is strong AGAINST.
 *
 * <p>Three clauses carry the whole thing and none is decoration.</p>
 *
 * <p><b>`a.civ &lt; b.civ`</b> does two jobs at once. The self-join sees each match twice — once
 * from each player — so without a canonical order every pair would appear as both "A vs B" and
 * "B vs A", the same games counted under two names with mirrored records. It also drops MIRROR
 * matchups, which is deliberate: a civ against itself is 50% by construction and carries no
 * balance signal.</p>
 *
 * <p><b>`b.user_id &lt;&gt; a.user_id`</b> is what stops a player being joined to themselves.</p>
 *
 * <p><b>The rated-1v1 filter is copied from /stats/civs verbatim, and must stay that way.</b>
 * `rating_mode` is NULL for every match stored before migration 0010 and those were all 1v1, so
 * NULL reads as 'default' rather than being skipped. A team game answers a different question
 * and an unrated one was never judged. If the two tables filtered differently, a civ's overall
 * record would not reconcile with the sum of its matchups and neither number could be trusted.</p>
 *
 * <p>Wins and losses are counted from the perspective of `civ_a`, the alphabetically first of
 * the pair. Draws are neither, exactly as in the civ table — a 0.5 is a match that was played
 * and not decided, and the launcher withholds a percentage until enough of them were.</p>
 *
 * <p>Binds: the minimum played, then the row limit.</p>
 */
export const MATCHUPS_SQL = `SELECT m.mod_id, m.mod_combined_hash,
                    a.civ AS civ_a, b.civ AS civ_b,
                    COUNT(*) AS played,
                    SUM(CASE WHEN a.result >= 0.999 THEN 1 ELSE 0 END) AS wins_a,
                    SUM(CASE WHEN a.result <= 0.001 THEN 1 ELSE 0 END) AS losses_a
               FROM match_participants a
               JOIN match_participants b
                 ON b.match_id = a.match_id AND b.user_id <> a.user_id
               JOIN matches m ON m.id = a.match_id
              WHERE a.civ IS NOT NULL AND TRIM(a.civ) <> ''
                AND b.civ IS NOT NULL AND TRIM(b.civ) <> ''
                AND a.civ < b.civ
                AND m.rated = 1
                AND (m.rating_mode IS NULL OR m.rating_mode = 'default')
              GROUP BY m.mod_id, m.mod_combined_hash, a.civ, b.civ
             HAVING played >= ?
              ORDER BY played DESC, a.civ ASC, b.civ ASC
              LIMIT ?`;

/**
 * The most-played maps of the window, most first.
 *
 * <p>ONE query serves both `top_maps` and the older singular `top_map`, which is derived from
 * its first row rather than fetched again. Two queries would be free to disagree — a different
 * window, a different tiebreak — and then `top_map` would quietly stop being the head of
 * `top_maps` with nothing to reveal it. Deriving makes that impossible instead of unlikely.</p>
 *
 * <p>The tiebreak is not decoration: with two maps on the same count the winner would otherwise
 * change between one request and the next. That mattered for a single card; for a LIST it
 * reorders the whole table, so it matters more.</p>
 *
 * <p>The bound parameters are positional: the window offset, then the row limit.</p>
 */
/**
 * Which cards the community BRINGS, most-carried first.
 *
 * <p>Counts DISTINCT USERS, never rows: one player's deck contributes one to each of its
 * cards and no more, so the table measures how many people carry a card rather than how
 * many decks happen to hold it. A player with the same card in four civilizations' decks is
 * four different facts, which is why the civ is part of the group.</p>
 *
 * <p>It says what people TAKE, never what they played — the recording carries neither the
 * card played nor the deck it came from, and that is a property of the format rather than a
 * gap. Every surface built on this has to say so.</p>
 *
 * <p>Binds: the minimum carriers, then the row limit.</p>
 */
export const DECK_CARDS_SQL = `SELECT mod_id, civ, card, COUNT(DISTINCT user_id) AS players
               FROM deck_cards
              GROUP BY mod_id, civ, card
             HAVING players >= ?
              ORDER BY players DESC, civ ASC, card ASC
              LIMIT ?`;

export const TOP_MAPS_SQL = `SELECT map_name, COUNT(*) AS n
               FROM matches
              WHERE map_name IS NOT NULL AND map_name <> ''
                AND created_at >= datetime('now', ?)
              GROUP BY map_name
              ORDER BY n DESC, map_name ASC
              LIMIT ?`;


/** The same rule as {@link LADDER_ORDER_BY}, for tests and for anything that has to explain it. */
export function conservativeRating(row: { rating: number; rd: number }): number {
    return row.rating - 2 * row.rd;
}

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

/** The civilization table's own memo. Same TTL, its own slot: it is fetched by a different
 *  page and a different set of clients, so sharing one would evict the busy one constantly. */
let civCache: { at: number; payload: unknown } | null = null;
let matchupCache: { at: number; payload: unknown } | null = null;
let deckCache: { at: number; payload: unknown } | null = null;

/** A civilization is listed once it has been played this many RATED 1v1s. One is enough to be
 *  a fact; what needs a sample is the win RATE, and that bar lives in the launcher, next to the
 *  card that decides whether to print one. */
const CIV_MIN_PLAYED = 1;

/** How many rows the table carries. Wars of Liberty ships 188 civilizations and this is per mod
 *  AND per version, so the cap is what stops one payload from growing without bound. */
const CIV_LIMIT = 400;

/**
 * A pair is listed from its first game. There is no bar here because the LAUNCHER has one: it
 * prints the record always and the percentage only past five decided, so a 1-match pair shows
 * "1-0" with no rate rather than a claim. Hiding it here instead would make a pair that exists
 * invisible, and "no games between these two" is itself worth seeing on a balance table.
 */
const MATCHUP_MIN_PLAYED = 1;

/**
 * Pairs, not civilizations: 188 civilizations could in principle produce ~17,500 of them, but
 * only pairs somebody actually played exist as rows. 600 is far above any real league and still
 * bounds the payload if a mod with a huge roster ever fills it.
 */
const MATCHUP_LIMIT = 600;

/**
 * A card is listed as soon as ONE person carries it. There is no bar because the figure is a
 * headcount rather than a rate — "1 player" is a true and complete statement, unlike a win
 * percentage over one game — and hiding the long tail would remove exactly what a modder
 * looking for an unused card came for.
 */
const DECK_MIN_PLAYERS = 1;

/** Wars of Liberty ships 4,517 cards across 188 civilizations; this bounds the payload. */
const DECK_LIMIT = 800;

/** How many cards one upload may declare. A deck holds 25; 188 civilizations of them is the
 *  ceiling a legitimate client can reach, and this sits above it without being unbounded. */
const DECK_UPLOAD_MAX_CARDS = 6000;

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
 *
 * <p><b>The order is `rating - 2 * rd`, not `rating` — the CONSERVATIVE rating, and it is the
 * whole answer to "somebody wins three games on his first night and lands above the regulars".
 * </b> It is Glicko-2's own recommendation: how good the player is AT LEAST, at roughly 95%
 * confidence. A newcomer carries an enormous deviation, so the number he is ranked by is
 * heavily discounted no matter how well he starts, and he climbs on his own as it shrinks —
 * which is exactly what "he has not proved it yet" means, expressed in the units the rating
 * system already keeps. Measured on the live table the day this changed: rating alone gave
 * Gommiustan (1626, rd 248, 3 matches) > Aluclown (1604, rd 125, 13); this gives Aluclown
 * (1353) > Geaf (1244) > Gommiustan (1130).</p>
 *
 * <p>The trade-off, and the client has to carry it: the rating SHOWN is still `rating`, so the
 * displayed numbers no longer descend down the table. That is why the launcher's rows print
 * the match count beside the name — it is what makes the order legible — and mark a high
 * deviation as provisional. Emitting the adjusted number instead was rejected: it would
 * contradict the rating the same player is shown in his profile and in every room.</p>
 *
 * <p>Note `idx_elo_rating (mode, rating DESC)` no longer serves this ORDER BY. Irrelevant at
 * this size; if the table ever grows, the index to add is on the expression.</p>
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
         ${LADDER_WHERE}
         ORDER BY ${LADDER_ORDER_BY}
         LIMIT ?`,
    ).bind(WIN_AT, LOSS_AT, mode, mode, MIN_DECIDED, limit).all<LeaderRow>();

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

/**
 * How many players are ON a ladder, ignoring the page limit.
 *
 * <p>It exists because the launcher's profile says "rank 7 of 18", and `leaderboard.length`
 * is only that number while the table is smaller than the page — the day it passes 50 that
 * sentence would quietly start reporting the page size as the size of the league.</p>
 *
 * <p>It shares {@link LADDER_WHERE} with the list itself, which is the only reason the two
 * can be trusted to describe the same set of people.</p>
 */
async function ladderSize(ctx: AppContext, mode: 'default' | 'team'): Promise<number> {
    const row = await ctx.db.prepare(
        `SELECT COUNT(*) AS n
         FROM elo_ratings e
         JOIN users u ON u.id = e.user_id
         ${LADDER_WHERE}`,
    ).bind(mode, MIN_DECIDED).first<{ n: number }>();
    return row?.n ?? 0;
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
        const [leaderboard, leaderboard_team, ranked_players, ranked_players_team] =
            await Promise.all([
                ladder(ctx, 'default', limit),
                ladder(ctx, 'team', limit),
                ladderSize(ctx, 'default'),
                ladderSize(ctx, 'team'),
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

        // The whole list, and the singular below is its head. See TOP_MAPS_SQL for why that is
        // one query and not two. Same `limit` the ladders take, so a caller asking for a bigger
        // page gets a bigger page of everything.
        const topMapRows = await ctx.db.prepare(TOP_MAPS_SQL)
            .bind(`-${ACTIVITY_WINDOW_DAYS} days`, limit).all<TopMapRow>();

        const top_maps = (topMapRows.results ?? []).map(r => ({ map: r.map_name, matches: r.n }));
        const topMap = topMapRows.results?.[0] ?? null;

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
            // How many players are on each ladder in total, which is NOT the length of the
            // lists above once the league outgrows the page. The profile's "rank 7 of 18"
            // reads these; a launcher older than them shows the rank alone.
            ranked_players,
            ranked_players_team,
            totals: {
                window_days: ACTIVITY_WINDOW_DAYS,
                matches: totals?.matches ?? 0,
                players_window_days: ACTIVE_PLAYERS_WINDOW_DAYS,
                players: totals?.players ?? 0,
                // null, never "" — the client shows the row only when there IS a map, and
                // an empty string would render as a blank value under a live heading.
                //
                // KEPT once top_maps arrived: every launcher shipped before it reads these two
                // and nothing else, so dropping them empties that card with no error to explain
                // it. They are the head of the list below, never a second query — see
                // TOP_MAPS_SQL.
                top_map: topMap?.map_name ?? null,
                top_map_matches: topMap?.n ?? 0,
                // The launcher's ranking summary card takes the first few and its STATS table
                // shows them all. A launcher older than this field deserializes it to null and
                // hides both, which is why it can ship before anyone updates.
                top_maps,
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

    /**
     * How each civilization is doing — the community's balance table, and the reason the
     * launcher started resolving civilization names at all.
     *
     * Grouped by mod AND by VERSION. `mod_combined_hash` has been stored on every match since
     * migration 0005 and read by nobody; it pins the exact build, so 1.2.0e and 1.2.0f do not
     * average together. Mixing them would make the number useless at exactly the moment a modder
     * changes something, which is the moment it exists for.
     *
     * Only RATED 1v1s. `rating_mode` is NULL for every match stored before migration 0010 and
     * those were all 'default', so NULL has to be read as 1v1 rather than skipped. Team games are
     * excluded because a civilization's record in a 2v2 answers a different question, and unrated
     * ones because they were never judged.
     *
     * The launcher decides what to SHOW: the record and the count always, a percentage only past
     * its own bar, and never an ordering by that percentage. This endpoint only counts.
     */
    app.get('/stats/civs', {
        preHandler: [ipRateLimit(ctx, Limits.StatsCivsIp)],
    }, async (_req, reply) => {
        const now = Date.now();
        if (civCache && now - civCache.at < CACHE_TTL_MS) {
            reply.header('Cache-Control', 'public, max-age=60');
            return civCache.payload;
        }

        const rows = await ctx.db.prepare(
            `SELECT m.mod_id, m.mod_combined_hash, mp.civ,
                    COUNT(*) AS played,
                    SUM(CASE WHEN mp.result >= 0.999 THEN 1 ELSE 0 END) AS wins,
                    SUM(CASE WHEN mp.result <= 0.001 THEN 1 ELSE 0 END) AS losses,
                    AVG(m.duration_seconds) AS avg_seconds
               FROM match_participants mp
               JOIN matches m ON m.id = mp.match_id
              WHERE mp.civ IS NOT NULL AND TRIM(mp.civ) <> ''
                AND m.rated = 1
                AND (m.rating_mode IS NULL OR m.rating_mode = 'default')
              GROUP BY m.mod_id, m.mod_combined_hash, mp.civ
             HAVING played >= ?
              ORDER BY played DESC, mp.civ ASC
              LIMIT ?`,
        ).bind(CIV_MIN_PLAYED, CIV_LIMIT).all<{
            mod_id: string;
            mod_combined_hash: string;
            civ: string;
            played: number;
            wins: number;
            losses: number;
            avg_seconds: number | null;
        }>();

        const civs = (rows.results ?? []).map((r) => ({
            mod_id: r.mod_id,
            mod_version: r.mod_combined_hash,
            civ: r.civ,
            played: r.played,
            wins: r.wins,
            losses: r.losses,
            avg_seconds: r.avg_seconds == null ? null : Math.round(r.avg_seconds),
        }));

        // Counted, not derived. Summing the rows and halving them would assume BOTH players'
        // civilizations resolved, and one of them failing is ordinary — a mod that ships its civ
        // list inside Data.bar resolves neither, and a roster that could not be joined resolves
        // none. The launcher prints this figure above the table, so it has to be the real one.
        const matched = await ctx.db.prepare(
            `SELECT COUNT(DISTINCT m.id) AS n
               FROM match_participants mp
               JOIN matches m ON m.id = mp.match_id
              WHERE mp.civ IS NOT NULL AND TRIM(mp.civ) <> ''
                AND m.rated = 1
                AND (m.rating_mode IS NULL OR m.rating_mode = 'default')`,
        ).bind().first<{ n: number }>();

        const payload = {
            generated_at: new Date(now).toISOString(),
            // How many matches contributed anything at all. The launcher says it out loud above
            // the table: with civilizations only reported from one build onwards, "nothing here
            // yet" is the honest state for a while and a blank table would read as broken.
            rated_matches_with_civ: matched?.n ?? 0,
            civs,
        };

        civCache = { at: now, payload };
        reply.header('Cache-Control', 'public, max-age=60');
        return payload;
    });

    /**
     * Civilization against civilization. See {@link MATCHUPS_SQL} for the rules; this only
     * serves it.
     *
     * <p>Its OWN rate-limit scope and its OWN cache slot, following the house rule the Limits
     * table spells out: a rarely-opened table must not be able to starve the busy one behind a
     * shared Radmin NAT.</p>
     *
     * <p>Counts only. The launcher decides what to SHOW — the record and the count always, a
     * percentage only past its own bar of decided games, and never an ordering by that
     * percentage. Sorting a rate computed from three matches puts whoever went 1-0 at the top
     * and calls it the best matchup in the game.</p>
     */
    app.get('/stats/matchups', {
        preHandler: [ipRateLimit(ctx, Limits.StatsMatchupsIp)],
    }, async (_req, reply) => {
        const now = Date.now();
        if (matchupCache && now - matchupCache.at < CACHE_TTL_MS) {
            reply.header('Cache-Control', 'public, max-age=60');
            return matchupCache.payload;
        }

        const rows = await ctx.db.prepare(MATCHUPS_SQL)
            .bind(MATCHUP_MIN_PLAYED, MATCHUP_LIMIT).all<{
                mod_id: string;
                mod_combined_hash: string;
                civ_a: string;
                civ_b: string;
                played: number;
                wins_a: number;
                losses_a: number;
            }>();

        const matchups = (rows.results ?? []).map((r) => ({
            mod_id: r.mod_id,
            mod_version: r.mod_combined_hash,
            civ_a: r.civ_a,
            civ_b: r.civ_b,
            played: r.played,
            wins_a: r.wins_a,
            losses_a: r.losses_a,
        }));

        const payload = {
            generated_at: new Date(now).toISOString(),
            matchups,
        };

        matchupCache = { at: now, payload };
        reply.header('Cache-Control', 'public, max-age=60');
        return payload;
    });

    /**
     * Which cards the community brings. See {@link DECK_CARDS_SQL}; this only serves it.
     */
    app.get('/stats/decks', {
        preHandler: [ipRateLimit(ctx, Limits.StatsDecksIp)],
    }, async (_req, reply) => {
        const now = Date.now();
        if (deckCache && now - deckCache.at < CACHE_TTL_MS) {
            reply.header('Cache-Control', 'public, max-age=60');
            return deckCache.payload;
        }

        const rows = await ctx.db.prepare(DECK_CARDS_SQL)
            .bind(DECK_MIN_PLAYERS, DECK_LIMIT).all<{
                mod_id: string; civ: string; card: string; players: number;
            }>();

        // Counted, never derived by summing the rows: a player contributes to many cards, so
        // any arithmetic over the list above would report a multiple of the real headcount —
        // and the launcher prints this figure above the table.
        const contributors = await ctx.db.prepare(
            'SELECT COUNT(DISTINCT user_id) AS n FROM deck_cards',
        ).bind().first<{ n: number }>();

        const payload = {
            generated_at: new Date(now).toISOString(),
            contributors: contributors?.n ?? 0,
            cards: rows.results ?? [],
        };

        deckCache = { at: now, payload };
        reply.header('Cache-Control', 'public, max-age=60');
        return payload;
    });

    /**
     * A player contributing their own decks. OPT-IN on the launcher side; nothing here can
     * tell, so this endpoint's job is to make an upload harmless rather than to police it.
     *
     * <p>It REPLACES that user's cards for each civilization it names — delete then insert,
     * in one batch — so re-uploading is idempotent and a player who opens the launcher daily
     * counts once. A civilization the upload does not mention is left alone, which is what
     * makes a partial upload safe.</p>
     *
     * <p>It stores no deck NAME and no timestamp of play: a deck name is whatever the player
     * typed, and there is no match here to attach anything to. The rows say only "this
     * account carries this card for this civilization in this mod".</p>
     */
    app.post('/stats/decks', {
        preHandler: [requireAuth(), userRateLimit(ctx, Limits.StatsDeckUpload)],
    }, async (req) => {
        const userId = req.userId!;
        const body = (req.body ?? null) as {
            mod_id?: unknown;
            decks?: { civ?: unknown; cards?: unknown }[];
        } | null;

        const modId = typeof body?.mod_id === 'string' ? body.mod_id.trim() : '';
        if (!modId) throw Errors.BadRequest('mod_id is required');
        if (!Array.isArray(body?.decks)) throw Errors.BadRequest('decks is required');

        const writes: { sql: string; params: unknown[] }[] = [];
        let cards = 0;

        for (const deck of body!.decks!) {
            const civ = typeof deck?.civ === 'string' ? deck.civ.trim() : '';
            if (!civ || !Array.isArray(deck?.cards)) continue;

            // Whatever this account had for this civilization goes first, so a card the player
            // removed from their deck stops being counted instead of lingering for ever.
            writes.push({
                sql: 'DELETE FROM deck_cards WHERE user_id = ? AND mod_id = ? AND civ = ?',
                params: [userId, modId, civ],
            });

            const seen = new Set<string>();
            for (const raw of deck.cards as unknown[]) {
                const card = typeof raw === 'string' ? raw.trim() : '';
                // De-duplicated here as well as by the primary key: a deck can legitimately
                // hold the same card twice, and two INSERTs of one row inside a single batch
                // would abort the whole transaction rather than be ignored.
                if (!card || seen.has(card)) continue;
                seen.add(card);
                if (++cards > DECK_UPLOAD_MAX_CARDS) {
                    throw Errors.BadRequest('too many cards');
                }
                writes.push({
                    sql: 'INSERT INTO deck_cards (user_id, mod_id, civ, card) VALUES (?, ?, ?, ?)',
                    params: [userId, modId, civ, card],
                });
            }
        }

        if (writes.length > 0) {
            await ctx.db.batch(writes.map(w => ctx.db.prepare(w.sql).bind(...w.params)));
            // The aggregate is memoised for a minute and would otherwise keep serving a table
            // that predates this upload — which reads, to the person who just opted in, as the
            // feature not working.
            deckCache = null;
        }

        return { ok: true, cards };
    });
}
