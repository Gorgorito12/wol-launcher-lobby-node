import type { FastifyInstance } from 'fastify';
import { chargeIpQuota, ipRateLimit, userRateLimit, Limits } from '../middleware/rateLimit';
import { requireAuth } from '../middleware/auth';
import { Errors } from '../lib/errors';
import { WIN_AT, LOSS_AT } from '../elo/ratability';
import { attachParticipants } from '../matches/rest';
import { currentSeason, isClosed, seasonBounds, seasonList, seasonOfCreatedAt,
         seasonPredicate } from '../elo/seasons';
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
 * Fewest RATED games before a player is on the table. Five: see the last paragraphs for why it
 * went back up.
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
 * <p><b>ONE, and it has now gone 5 → 1 → 5 → 1, so read why before moving it again.</b> It
 * went back to five because the launcher hangs a rank badge off the position, and with a bar
 * of one the badges read as a lottery. That objection was answered in the LAUNCHER, not here:
 * the ages are now cut by a SHARE of the table (top 10 % Sovereign, the next 15 % Imperial,
 * and so on — `RankAges` there), and the ORDER BY below still sinks a one-match player on his
 * own (rd ≈ 290, so `rating - 2*rd` puts him last). What five cost was the table itself: a
 * handful of names out of everybody who plays, and the maintainer asked for everybody.</p>
 *
 * <p>So the bar is back to "has a rating at all". The launcher's win percentage keeps its OWN
 * sample bar (five decided matches) — that is a different question and no longer borrows this
 * number.</p>
 *
 * <p>It never goes below 1: `elo_ratings` gains a row when `applyMatch` first runs, so a
 * player with nothing decided has no rating to rank, and the launcher prints this number
 * (`min_decided`).</p>
 */
export const MIN_DECIDED = 1;

/**
 * How good a player is AT LEAST — Glicko-2's conservative estimate, the number the ladder is
 * ordered by. Exported as BOTH the SQL fragment and the same arithmetic in JS so the query and
 * the test that pins it cannot drift apart; the string is a module constant, never user input.
 *
 * <p>Two, not one: measured on the live table, a single deviation still put the three-match
 * player second instead of third. Two is also what Glicko-2's own write-up recommends.</p>
 *
 * <p>The `user_id` tiebreak is load-bearing since {@link ladderRanks} exists. Without it two
 * players on the same conservative rating came back in whatever order SQLite chose, which was
 * harmless while the position lived only in the list — and wrong the moment a second query
 * computes the same position for a room, because the two could disagree about who is 3rd.</p>
 */
export const LADDER_ORDER_BY = '(e.rating - 2 * e.rd) DESC, e.user_id ASC';

/**
 * Who is on a ladder at all. SHARED, not copied, by the list and by the count of it.
 *
 * <p>A count that filtered differently from the list it describes would be worse than no
 * count: it would put somebody at "7 of 18" in a table showing 20 names, and the disagreement
 * would be invisible from either side. Two queries spelling out the same three conditions is
 * exactly the shape that drifts, so there is one string and both interpolate it.</p>
 *
 * <p>The bound parameters are positional, so a caller must bind mode, MIN_DECIDED and then the
 * SEASON, in that order, after whatever its own SELECT needs. The season is LAST on purpose: it
 * arrived after the other two, and appending it is what kept every existing `bind()` correct
 * except for one extra argument at its end.</p>
 *
 * <p><b>`e` is `season_ratings`, and the season is the CURRENT one</b> wherever this is used —
 * the live ladder, a badge, "may wear the team badge". An ended season's table is not read
 * through this: see {@link seasonPlacesCte}, which drops the ban filter so a past table never
 * renumbers.</p>
 */
export const LADDER_WHERE = `WHERE e.mode = ?
           AND u.is_banned = 0
           AND e.games_played >= ?
           AND e.season = ?`;

/**
 * A player's position on a ladder, for the surfaces that show a player without showing the
 * ladder: the rooms list (the host) and the room itself (every member). The launcher turns it
 * into the rank badge, so it MUST be the same number the table prints next to that player.
 *
 * <p>That is why it is a window function over the list's own two constants rather than a
 * "count who is ahead of me" query: a COUNT would have to restate the WHERE and the ordering
 * with a second alias, which is the two-copies shape {@link LADDER_WHERE} exists to prevent.
 * Here the list and the position cannot filter or order differently.</p>
 *
 * <p>Binds: mode, MIN_DECIDED, season, then the user ids.</p>
 */
export function ladderRankSql(userCount: number): string {
    const ids = Array.from({ length: userCount }, () => '?').join(', ');
    return `WITH ranked AS (
                SELECT e.user_id AS user_id,
                       ROW_NUMBER() OVER (ORDER BY ${LADDER_ORDER_BY}) AS ladder_pos
                FROM season_ratings e
                JOIN users u ON u.id = e.user_id
                ${LADDER_WHERE}
            )
            SELECT user_id, ladder_pos FROM ranked WHERE user_id IN (${ids})`;
}

/**
 * Positions for a handful of players, in ONE query. A player who is not on the ladder is
 * mapped to 0, NOT left out: the launcher reads 0 as "below the entry bar" (the Discovery
 * badge) and a MISSING field as "this server does not know", which draws no badge at all.
 * Never throws — a room must not fail to open because a badge could not be worked out; on an
 * error the map is empty and the field is simply omitted.
 */
export async function ladderRanks(
    ctx: AppContext,
    userIds: string[],
    mode: 'default' | 'team' = 'default',
    season: number = currentSeason(Date.now()),
): Promise<Map<string, number>> {
    const unique = [...new Set(userIds.filter(Boolean))];
    const out = new Map<string, number>();
    if (unique.length === 0) return out;
    try {
        const rows = await ctx.db.prepare(ladderRankSql(unique.length))
            .bind(mode, MIN_DECIDED, season, ...unique)
            .all<{ user_id: string; ladder_pos: number }>();
        for (const id of unique) out.set(id, 0);
        for (const r of rows.results ?? []) out.set(r.user_id, r.ladder_pos);
    } catch {
        out.clear();
    }
    return out;
}

/**
 * The JS mirror of {@link LADDER_ORDER_BY}, tiebreak included, for tests and for anything that
 * has to explain the order.
 */
export function compareLadder(
    a: { rating: number; rd: number; user_id: string },
    b: { rating: number; rd: number; user_id: string },
): number {
    const diff = (b.rating - 2 * b.rd) - (a.rating - 2 * a.rd);
    if (diff !== 0) return diff;
    return a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
}

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
/**
 * The pair query, for one mode and one SIDE of the table.
 *
 * <p><b>`side` is what makes this work for team games at all.</b> The join pairs every
 * participant with every other, which in a 1v1 can only ever be the opponent — but in a 3v3 it
 * also pairs teammates, fifteen pairs a match, and calling that a matchup would be nonsense.
 * `'rivals'` adds `b.team <> a.team`; `'allies'` adds `b.team = a.team` and answers the other
 * question a team format raises, which is who a civilization is played WITH.</p>
 *
 * <p>The rivals predicate is a no-op in 1v1 — the two sides are always different — so the same
 * query serves both modes rather than a second one that could drift.</p>
 */
export function matchupsSql(
    mod: string | null,
    mode: 'default' | 'team' = 'default',
    side: 'rivals' | 'allies' = 'rivals',
): string {
    // ONLY in team mode. In a 1v1 the two players are opponents by definition, and asking
    // SQL to prove it would delete the entire pre-0010 history: those rows predate the team
    // column and carry team 0 for everybody, so `b.team <> a.team` is false on every one of
    // them. A predicate that looks like a no-op and silently empties a table.
    const team = mode !== 'team' ? ''
        : side === 'allies' ? ' AND b.team = a.team'
        : ' AND b.team <> a.team';

    return MATCHUPS_SQL
        .replace(
            "ON b.match_id = a.match_id AND b.user_id <> a.user_id",
            `ON b.match_id = a.match_id AND b.user_id <> a.user_id${team}`)
        .replace(
            "AND (m.rating_mode IS NULL OR m.rating_mode = 'default')",
            modeClause(mode).trimStart())
        .replace(
            "AND a.civ < b.civ",
            `AND a.civ < b.civ${mod ? ' AND m.mod_id = ?' : ''}`);
}

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
export function deckCardsSql(mod: string | null): string {
    return mod
        ? DECK_CARDS_SQL.replace('FROM deck_cards', 'FROM deck_cards WHERE mod_id = ?')
        : DECK_CARDS_SQL;
}

export const DECK_CARDS_SQL = `SELECT mod_id, civ, card, COUNT(DISTINCT user_id) AS players
               FROM deck_cards
              GROUP BY mod_id, civ, card
             HAVING players >= ?
              ORDER BY players DESC, civ ASC, card ASC
              LIMIT ?`;

/**
 * One mod, or all of them.
 *
 * <p>Every window query in `/stats/community` reads `matches` or `lobbies`, and BOTH tables
 * carry `mod_id`. So a per-mod page costs one predicate on a scan that already happens —
 * `created_at` is not indexed and these queries already walk the table, as the comment on the
 * totals query says. What it buys is a page that means one thing: the launcher draws
 * civilizations, matchups and decks per mod (the server groups those by `mod_id` already), and
 * a map list spanning every mod underneath them was the odd one out.</p>
 *
 * <p>Returned as a fragment plus its bindings rather than interpolated, because the whole point
 * is that the four callers below apply it identically or not at all. Half a page filtered is
 * worse than none of it.</p>
 */
function modClause(mod: string | null): { sql: string; args: string[] } {
    return mod ? { sql: ' AND mod_id = ?', args: [mod] } : { sql: '', args: [] };
}

/**
 * The `?mod=` a caller asked for, or null for every mod.
 *
 * <p>One reader for all four routes. They either agree on what "this mod" means or the
 * launcher's page shows four different answers to one question.</p>
 */
function modParam(req: { query?: unknown }): string | null {
    const q = req.query as { mod?: string } | undefined;
    return typeof q?.mod === 'string' && q.mod.trim() ? q.mod.trim().slice(0, 64) : null;
}

/**
 * Which ladder a caller is asking about: 1v1 or team.
 *
 * <p>Defaults to `'default'` — the 1v1 figures — so a launcher that has never heard of the
 * parameter keeps receiving exactly what it received before. Anything unrecognised falls back
 * the same way rather than erroring: this is a read-only page and refusing it would cost a
 * blank screen over a typo.</p>
 */
function modeParam(req: { query?: unknown }): 'default' | 'team' {
    const q = req.query as { mode?: string } | undefined;
    return q?.mode === 'team' ? 'team' : 'default';
}

/**
 * The rating-mode predicate for one mode.
 *
 * <p><b>NULL reads as 1v1, and only as 1v1.</b> `rating_mode` is null for every match stored
 * before migration 0010 and those were all 1v1, so folding NULL into the team branch would
 * quietly count the entire pre-team history as team games.</p>
 */
function modeClause(mode: 'default' | 'team', alias = 'm'): string {
    return mode === 'team'
        ? ` AND ${alias}.rating_mode = 'team'`
        : ` AND (${alias}.rating_mode IS NULL OR ${alias}.rating_mode = 'default')`;
}

export function topMapsSql(mod: string | null, mode: 'default' | 'team' | null = null): string {
    // `FROM matches m` only so the mode predicate has an alias to name. Every other column
    // stays unqualified: there is one table here, they resolve the same, and the tests that
    // pin the window and the tiebreak read this text.
    return `SELECT map_name, COUNT(*) AS n
               FROM matches m
              WHERE map_name IS NOT NULL AND map_name <> ''
                AND created_at >= datetime('now', ?)${modClause(mod).sql}${mode ? modeClause(mode) : ''}
              GROUP BY map_name
              ORDER BY n DESC, map_name ASC
              LIMIT ?`;
}

/** Kept for the tests that pin the unfiltered shape, and for anything reading it by name. */
export const TOP_MAPS_SQL = topMapsSql(null);


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

/** How many finished matches the strip lists when the caller does not say. Five is what
 *  fits the Rooms card without the panel growing into the room list above it. */
export const RECENT_MATCHES_LIMIT = 5;

/** The most a caller may ask for with `recent=N`. The Ranking page's history list asks
 *  for 30; forty is a page and a half of that, and every match costs a participants row
 *  in the same payload, so this is a cap on payload size rather than on curiosity. */
export const RECENT_MATCHES_MAX = 40;

/**
 * `recent=N`: how many of the community's latest matches ride the payload. Absent means
 * what it always was; anything unparseable means the same, so a launcher that has never
 * heard of the parameter — or one that sends nonsense — keeps getting five.
 */
export function recentParam(raw: unknown): number {
    if (typeof raw !== 'string' || !raw.trim()) return RECENT_MATCHES_LIMIT;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return RECENT_MATCHES_LIMIT;
    return Math.min(RECENT_MATCHES_MAX, Math.max(1, n));
}

/** Server-side memo. The contents change at most once per finished match, and a
 *  minute of staleness on a decorative card is invisible; what it buys is that a
 *  roomful of players opening the tab together costs one query, not eight. */
const CACHE_TTL_MS = 60_000;
interface CacheEntry { at: number; payload: unknown }

/**
 * One entry PER KEY, not one entry.
 *
 * It used to be a single slot holding its own (limit, mod, mode) and compared on read, so
 * two players looking at different mods evicted each other on every request and the hit
 * rate fell to nothing precisely when the most people were on the tab. A Map keyed by the
 * same triple costs the same to read and actually memoises.
 *
 * Bounded by pruning on write rather than by an LRU: the key space is small and bounded by
 * the mod catalogue, and entries are worthless after 60 s anyway.
 */
const communityCache = new Map<string, CacheEntry>();

/**
 * Requests already computing a key, so a cold entry is computed ONCE.
 *
 * Without this, N clients arriving together on an expired entry all missed and all ran the
 * eight queries. better-sqlite3 is synchronous (see src/db.ts), so those are not eight
 * concurrent queries - they are eight blocking scans in a row, on the same thread that
 * serves the room list to everybody else. The second caller now awaits the first one's
 * promise.
 */
const communityInFlight = new Map<string, Promise<unknown>>();

/**
 * Every dimension the payload varies by is IN the key, or the memo hands one caller
 * another caller's answer. `recent` joined the triple the day the Ranking page started
 * asking for thirty matches: without it, the Rooms strip's five-row answer would have
 * been served to the ranking for a minute, and the other way round.
 */
export function communityKey(
    limit: number, mod: string | null, mode: string, recent: number = RECENT_MATCHES_LIMIT,
    season: number = 1,
): string {
    return `${limit}\u0000${mod ?? ''}\u0000${mode}\u0000${recent}\u0000${season}`;
}

/** Drop expired entries. Called on write, which is the only time the map grows. */
function pruneCommunityCache(now: number): void {
    for (const [key, entry] of communityCache) {
        if (now - entry.at >= CACHE_TTL_MS) communityCache.delete(key);
    }
}

/** The civilization table's own memo. Same TTL, its own slot: it is fetched by a different
 *  page and a different set of clients, so sharing one would evict the busy one constantly. */
let civCache: { at: number; mod: string | null; mode: string; payload: unknown } | null = null;
let matchupCache: { at: number; mod: string | null; mode: string; payload: unknown } | null = null;

/**
 * Forget the civilization and matchup tables, and the community payloads that carry
 * `top_civs`. Called by the matches routes when a confirmation has just filled in a
 * civilization a report left blank (migration 0019): the memo is a minute long, and a match
 * that just learned who played what should show up on the next request, not the next
 * minute. Cheap — three slots and a small map — and a no-op when nothing was cached.
 */
export function invalidateCivStatsCaches(): void {
    civCache = null;
    matchupCache = null;
    communityCache.clear();
}
let deckCache: { at: number; mod: string | null; payload: unknown } | null = null;

/** The list of mods that have matches. Its own slot; it is tiny and asked once a page. */
let modsCache: { at: number; payload: unknown } | null = null;

/** Ended seasons' tables, keyed by `season\0limit`. Bounded by the number of seasons. */
const seasonCache = new Map<string, CacheEntry>();
const SEASON_CACHE_TTL_MS = 5 * 60_000;

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
    season_wins: number;
    season_losses: number;
}

/** One civilization a player has been seen with, and how often. */
export interface TopCiv { civ: string; played: number }

/** How many civilizations a ladder row names. Three flags fit the column the launcher
 *  gives them; the STATS page holds the whole distribution. */
export const TOP_CIVS_PER_PLAYER = 3;

/**
 * Who played what, for a set of players: one row per (player, civilization) with a count.
 *
 * <p>RATED matches of the ladder's own mode, and NO time window, on purpose. The ladder is
 * not windowed either — a rating is the sum of everything — and with the data there is
 * today (civilizations only started arriving with launcher 1.0.14, and mostly through the
 * confirmation path since migration 0019) a thirty-day window would answer "nothing" for
 * almost everybody almost all the time, which is not what a player asking "what does he
 * play" wants to hear.</p>
 *
 * <p>Blank civilizations are excluded here and not merely counted as "unknown": an unknown
 * is not a civilization somebody plays, and on today's data it would top every list.</p>
 */
export function topCivsSql(players: number): string {
    const marks = Array.from({ length: players }, () => '?').join(', ');
    return `SELECT mp.user_id, mp.civ, COUNT(*) AS played
              FROM match_participants mp
              JOIN matches m ON m.id = mp.match_id
             WHERE m.rated = 1
               AND COALESCE(m.rating_mode, 'default') = ?
               AND mp.civ IS NOT NULL AND TRIM(mp.civ) <> ''
               AND mp.user_id IN (${marks})
             GROUP BY mp.user_id, mp.civ`;
}

/**
 * The top few per player, from the grouped rows. Most played first; on a tie the
 * civilization's name decides, so two players with the same record are listed the same
 * way every time rather than in whatever order SQLite grouped them today.
 *
 * <p>Pure, and exported for the tests: the SQL above is checked against a real database
 * on deploy, the CUT is checked here.</p>
 */
export function topCivsFor(
    rows: ReadonlyArray<{ user_id: string; civ: string; played: number }>,
    perPlayer: number = TOP_CIVS_PER_PLAYER,
): Map<string, TopCiv[]> {
    const byUser = new Map<string, TopCiv[]>();
    for (const r of rows) {
        const list = byUser.get(r.user_id) ?? [];
        list.push({ civ: r.civ, played: r.played });
        byUser.set(r.user_id, list);
    }
    for (const [user, list] of byUser) {
        list.sort((a, b) => b.played - a.played || a.civ.localeCompare(b.civ));
        byUser.set(user, list.slice(0, perPlayer));
    }
    return byUser;
}

interface HourRow { h: number; c: number }

interface TotalsRow { matches: number; rated: number; players: number }
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
 *
 * <p><b>One season's ladder.</b> `wins`/`losses` stay what they always were — every decided match
 * of the mode, all time — because launchers already shipped read them. `season_wins` /
 * `season_losses` are the RATED matches of the mode stored during this season, the record that
 * goes with this season's rating and the one the ranking prints.</p>
 */
async function ladder(
    ctx: AppContext,
    mode: 'default' | 'team',
    limit: number,
    season: number = currentSeason(Date.now()),
) {
    const inSeason = seasonPredicate(season, 'm.created_at');
    const rows = await ctx.db.prepare(
        `SELECT u.id, u.discord_username, u.display_name, u.avatar_url,
                e.rating, e.rd, e.games_played,
                COALESCE(w.wins, 0) AS wins, COALESCE(w.losses, 0) AS losses,
                COALESCE(s.wins, 0) AS season_wins, COALESCE(s.losses, 0) AS season_losses
         FROM season_ratings e
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
         LEFT JOIN (
             SELECT mp.user_id AS user_id,
                    SUM(CASE WHEN mp.result >= ? THEN 1 ELSE 0 END) AS wins,
                    SUM(CASE WHEN mp.result <= ? THEN 1 ELSE 0 END) AS losses
             FROM match_participants mp
             JOIN matches m ON m.id = mp.match_id
             WHERE m.rated = 1 AND COALESCE(m.rating_mode, 'default') = ?
               AND ${inSeason.sql}
             GROUP BY mp.user_id
         ) s ON s.user_id = e.user_id
         ${LADDER_WHERE}
         ORDER BY ${LADDER_ORDER_BY}
         LIMIT ?`,
    ).bind(
        WIN_AT, LOSS_AT, mode,
        WIN_AT, LOSS_AT, mode, ...inSeason.args,
        mode, MIN_DECIDED, season,
        limit,
    ).all<LeaderRow>();

    const players = rows.results ?? [];

    // What each of them plays: ONE query for the page, never one per row. The launcher
    // draws these as flags beside the name; a player with none gets an empty list, which
    // the launcher reads as "nothing known" and a launcher older than the field ignores.
    let topCivs = new Map<string, TopCiv[]>();
    if (players.length > 0) {
        const civRows = await ctx.db.prepare(topCivsSql(players.length))
            .bind(mode, ...players.map((p) => p.id))
            .all<{ user_id: string; civ: string; played: number }>();
        topCivs = topCivsFor(civRows.results ?? []);
    }

    // Each player's place on the OTHER ladder (design handoff 51a): a badge's tooltip always
    // names the other badge — "#2 in the teams ladder · 1v1: Industrial #5" — so a 1v1 row
    // carries its team position and a team row its 1v1 one. One batched query for the page;
    // the field is omitted on failure, which the launcher reads as "unknown".
    const other = await ladderRanks(
        ctx, players.map((p) => p.id), mode === 'team' ? 'default' : 'team', season);

    // The medal a top-3 finish in an ended season earns, drawn after the name. One query for
    // the page; omitted, never invented, when it fails.
    const titles = await seasonTitles(ctx, players.map((p) => p.id));

    // The rank is decided HERE, by the same ordering that produced the list. A client
    // filtering its copy must not renumber: the third row is the third player, not the
    // third thing that survived the client's own filter.
    return players.map((r, i) => ({
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
        season_wins: r.season_wins,
        season_losses: r.season_losses,
        top_civs: topCivs.get(r.id) ?? [],
        ...(mode === 'team'
            ? { ladder_rank: other.get(r.id) }
            : { ladder_rank_team: other.get(r.id) }),
        season_title: titles.get(r.id),
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
export async function ladderSize(
    ctx: AppContext,
    mode: 'default' | 'team',
    season: number = currentSeason(Date.now()),
): Promise<number> {
    const row = await ctx.db.prepare(
        `SELECT COUNT(*) AS n
         FROM season_ratings e
         JOIN users u ON u.id = e.user_id
         ${LADDER_WHERE}`,
    ).bind(mode, MIN_DECIDED, season).first<{ n: number }>();
    return row?.n ?? 0;
}

// ---------------------------------------------------------------- the season record

/**
 * Every player's FINAL place on every ENDED season's ladders — the record a season leaves.
 *
 * <p>The same ordering and the same entry bar as the live ladder ({@link LADDER_ORDER_BY},
 * {@link MIN_DECIDED}), so a season's final table is exactly the table that stood at its last
 * instant — with one deliberate difference: <b>no ban filter</b>. A table that dropped a player
 * banned later would renumber everybody below him, and a place somebody was told they finished
 * in must never change by itself. Only an operator correction (void/decide, which replays from
 * that season) can move it, and the command says so.</p>
 *
 * <p>ONE definition for every reader — the profile's history, the medals, the past table — so a
 * player can never be "#3" on one screen and "#4" on another.</p>
 *
 * <p>A function rather than a constant for the import-cycle reason badgeMode.ts documents.</p>
 *
 * <p>Binds: MIN_DECIDED, then the current season (exclusive: only ended seasons).</p>
 */
export function seasonPlacesCte(): string {
    return `WITH places AS (
        SELECT e.user_id, e.season, e.mode, e.rating, e.rd, e.games_played,
               ROW_NUMBER() OVER (PARTITION BY e.season, e.mode ORDER BY ${LADDER_ORDER_BY}) AS place,
               COUNT(*) OVER (PARTITION BY e.season, e.mode) AS size
          FROM season_ratings e
         WHERE e.games_played >= ? AND e.season < ?
    )`;
}

/** A top-3 finish in an ended season — the medal drawn after a player's name. */
export interface SeasonTitle {
    season: number;
    place: number;
    mode: 'default' | 'team';
}

/** How many places earn a medal. */
export const SEASON_TITLE_PLACES = 3;

/**
 * Which medal a player shows when he has several: the most recent season; inside one season the
 * better place; and between the two ladders at the same place, 1v1. Pure, for the tests.
 */
export function pickSeasonTitle(titles: readonly SeasonTitle[]): SeasonTitle | null {
    let best: SeasonTitle | null = null;
    for (const t of titles) {
        if (t.place < 1 || t.place > SEASON_TITLE_PLACES) continue;
        if (!best
            || t.season > best.season
            || (t.season === best.season && t.place < best.place)
            || (t.season === best.season && t.place === best.place
                && t.mode === 'default' && best.mode !== 'default')) {
            best = t;
        }
    }
    return best;
}

/**
 * Every top-3 finish of several players, in ONE query. Never throws: on an error the map is
 * empty and the field is omitted, which the launcher reads as "no medal known" — the same
 * contract {@link ladderRanks} keeps.
 */
export async function seasonTitlesAll(
    ctx: AppContext,
    userIds: readonly string[],
    nowMs: number = Date.now(),
): Promise<Map<string, SeasonTitle[]>> {
    const unique = [...new Set(userIds.filter(Boolean))];
    const out = new Map<string, SeasonTitle[]>();
    if (unique.length === 0) return out;
    try {
        const marks = unique.map(() => '?').join(', ');
        const rows = await ctx.db.prepare(
            `${seasonPlacesCte()}
             SELECT user_id, season, mode, place FROM places
              WHERE place <= ? AND user_id IN (${marks})
              ORDER BY season DESC, place ASC`,
        ).bind(MIN_DECIDED, currentSeason(nowMs), SEASON_TITLE_PLACES, ...unique)
            .all<{ user_id: string; season: number; mode: string; place: number }>();
        for (const r of rows.results ?? []) {
            const list = out.get(r.user_id) ?? [];
            list.push({ season: r.season, place: r.place, mode: r.mode === 'team' ? 'team' : 'default' });
            out.set(r.user_id, list);
        }
    } catch {
        out.clear();
    }
    return out;
}

/** The one medal each player shows. Omitted for a player with none, and on failure. */
export async function seasonTitles(
    ctx: AppContext,
    userIds: readonly string[],
    nowMs: number = Date.now(),
): Promise<Map<string, SeasonTitle>> {
    const all = await seasonTitlesAll(ctx, userIds, nowMs);
    const out = new Map<string, SeasonTitle>();
    for (const [id, list] of all) {
        const best = pickSeasonTitle(list);
        if (best) out.set(id, best);
    }
    return out;
}

/** One player's line in one ended season of one ladder, as his profile lists them. */
export interface PastSeason {
    season: number;
    mode: 'default' | 'team';
    place: number;
    size: number;
    rating: number;
    rd: number;
    games_played: number;
    wins: number;
    losses: number;
}

/**
 * A player's record across every ended season: his final place, the size of that table, his
 * final rating, and the rated matches he won and lost in it. Newest first.
 *
 * <p>The wins and losses are bucketed here by each match's own season rather than counted per
 * season in SQL: one player's rated history is small, and the bucketing is the same
 * {@link seasonOfCreatedAt} that filed the matches into their seasons in the first place.</p>
 */
export async function pastSeasonsFor(
    ctx: AppContext,
    userId: string,
    nowMs: number = Date.now(),
): Promise<PastSeason[]> {
    const places = await ctx.db.prepare(
        `${seasonPlacesCte()}
         SELECT season, mode, place, size, rating, rd, games_played FROM places
          WHERE user_id = ?
          ORDER BY season DESC, mode ASC`,
    ).bind(MIN_DECIDED, currentSeason(nowMs), userId).all<{
        season: number; mode: string; place: number; size: number;
        rating: number; rd: number; games_played: number;
    }>();
    const list = places.results ?? [];
    if (list.length === 0) return [];

    const record = await seasonRecordFor(ctx, userId);
    return list.map((p) => {
        const mode = p.mode === 'team' ? 'team' as const : 'default' as const;
        const tally = record.get(`${p.season}|${mode}`) ?? { wins: 0, losses: 0 };
        return {
            season: p.season, mode, place: p.place, size: p.size,
            rating: p.rating, rd: p.rd, games_played: p.games_played,
            wins: tally.wins, losses: tally.losses,
        };
    });
}

/** A player's decided RATED matches, per (season, ladder). Key: `season|mode`. */
export async function seasonRecordFor(
    ctx: AppContext,
    userId: string,
): Promise<Map<string, { wins: number; losses: number }>> {
    const rows = await ctx.db.prepare(
        `SELECT m.created_at, COALESCE(m.rating_mode, 'default') AS mode, mp.result
           FROM match_participants mp
           JOIN matches m ON m.id = mp.match_id
          WHERE mp.user_id = ? AND m.rated = 1`,
    ).bind(userId).all<{ created_at: string; mode: string; result: number }>();
    const out = new Map<string, { wins: number; losses: number }>();
    for (const r of rows.results ?? []) {
        const key = `${seasonOfCreatedAt(r.created_at)}|${r.mode === 'team' ? 'team' : 'default'}`;
        const tally = out.get(key) ?? { wins: 0, losses: 0 };
        if (r.result >= WIN_AT) tally.wins++;
        else if (r.result <= LOSS_AT) tally.losses++;
        out.set(key, tally);
    }
    return out;
}

/** An ended season's final table on one ladder, best first. */
export async function seasonTable(
    ctx: AppContext,
    season: number,
    mode: 'default' | 'team',
    limit: number,
    nowMs: number = Date.now(),
) {
    const inSeason = seasonPredicate(season, 'm.created_at');
    const rows = await ctx.db.prepare(
        `${seasonPlacesCte()}
         SELECT p.user_id, p.place, p.rating, p.rd, p.games_played,
                u.discord_username, u.display_name, u.avatar_url,
                COALESCE(s.wins, 0) AS wins, COALESCE(s.losses, 0) AS losses
           FROM places p
           JOIN users u ON u.id = p.user_id
           LEFT JOIN (
               SELECT mp.user_id AS user_id,
                      SUM(CASE WHEN mp.result >= ? THEN 1 ELSE 0 END) AS wins,
                      SUM(CASE WHEN mp.result <= ? THEN 1 ELSE 0 END) AS losses
                 FROM match_participants mp
                 JOIN matches m ON m.id = mp.match_id
                WHERE m.rated = 1 AND COALESCE(m.rating_mode, 'default') = ?
                  AND ${inSeason.sql}
                GROUP BY mp.user_id
           ) s ON s.user_id = p.user_id
          WHERE p.season = ? AND p.mode = ?
          ORDER BY p.place ASC
          LIMIT ?`,
    ).bind(
        MIN_DECIDED, currentSeason(nowMs),
        WIN_AT, LOSS_AT, mode, ...inSeason.args,
        season, mode, limit,
    ).all<{
        user_id: string; place: number; rating: number; rd: number; games_played: number;
        discord_username: string; display_name: string; avatar_url: string | null;
        wins: number; losses: number;
    }>();
    return (rows.results ?? []).map((r) => ({
        // The server's place, which the launcher must not renumber — same rule as the live table.
        rank: r.place,
        user_id: r.user_id,
        discord_username: r.discord_username,
        display_name: r.display_name,
        avatar_url: r.avatar_url,
        rating: r.rating,
        rd: r.rd,
        games_played: r.games_played,
        // A past table's record IS the season's: there is no all-time figure beside it.
        wins: r.wins,
        losses: r.losses,
        season_wins: r.wins,
        season_losses: r.losses,
    }));
}

/** How many players finished an ended season's ladder — the "of 18" in "#3 of 18". */
export async function seasonTableSize(
    ctx: AppContext,
    season: number,
    mode: 'default' | 'team',
    nowMs: number = Date.now(),
): Promise<number> {
    const row = await ctx.db.prepare(
        `${seasonPlacesCte()}
         SELECT COUNT(*) AS n FROM places WHERE season = ? AND mode = ?`,
    ).bind(MIN_DECIDED, currentSeason(nowMs), season, mode).first<{ n: number }>();
    return row?.n ?? 0;
}

/** The calendar as the launcher draws it: the running season, when it ends, and every one so far. */
export function seasonBlock(nowMs: number) {
    const current = currentSeason(nowMs);
    return {
        current,
        ends_at: new Date(seasonBounds(current).end).toISOString(),
        list: seasonList(nowMs),
    };
}

export function registerStatsRest(app: FastifyInstance, ctx: AppContext): void {
    // NO ipRateLimit preHandler here, on purpose - see the cache check below. The quota is
    // charged inside the handler, and only when the request is actually going to do work.
    app.get('/stats/community', async (req, reply) => {
        const query = req.query as { limit?: string; mod?: string; recent?: string } | undefined;
        const raw = query?.limit;
        const parsed = raw ? parseInt(raw, 10) : DEFAULT_LIMIT;
        const limit = Number.isFinite(parsed)
            ? Math.min(MAX_LIMIT, Math.max(1, parsed))
            : DEFAULT_LIMIT;
        // How many recent matches. The Rooms strip is happy with the default; the Ranking
        // page's history asks for thirty.
        const recent = recentParam(query?.recent);

        // Optional. Absent means every mod, which is exactly what this endpoint did before —
        // so a launcher that has never heard of the parameter keeps getting what it got.
        const mod = modParam(req);
        // The mode applies to the four WINDOW queries below. It cannot apply to the hour
        // histogram, which counts rooms in `lobbies` and has no rating mode to filter on -
        // said out loud on the card rather than pretended away.
        const mode = modeParam(req);
        const modeSql = modeClause(mode);
        const modSql = modClause(mod).sql;
        const modArgs = modClause(mod).args;

        const now = Date.now();
        // Part of the key, so the minute-long memo cannot carry one season's ladder past the
        // boundary into the next.
        const season = currentSeason(now);
        const key = communityKey(limit, mod, mode, recent, season);

        // THE MEMO IS CHECKED BEFORE THE QUOTA, and that ordering is the fix rather than a
        // shortcut. ipRateLimit used to be a preHandler, so a request answered entirely out
        // of this map still spent one of the 2000 daily requests an IP gets - and a launcher
        // polling once a minute with the tab open spends 1440 of them by itself. Two PCs
        // behind one router (or one CGNAT, which this player base is full of) therefore ran
        // out mid-afternoon and got 429 for the rest of the UTC day, which the client
        // rendered as an absent card, indistinguishable from "not enough data yet".
        //
        // A cached answer costs no query, so it costs no quota.
        const hit = communityCache.get(key);
        if (hit && now - hit.at < CACHE_TTL_MS) {
            reply.header('Cache-Control', 'public, max-age=60');
            return hit.payload;
        }

        // Past here the request is going to hit the database, so now it pays.
        await chargeIpQuota(ctx, req, reply, Limits.StatsPublicIp);

        // Somebody else is already computing this exact key: wait for theirs instead of
        // running the same eight scans again on the one synchronous thread.
        const pending = communityInFlight.get(key);
        if (pending) {
            reply.header('Cache-Control', 'public, max-age=60');
            return pending;
        }

        // ONE computation per key, shared. The map entry is set BEFORE the first await
        // inside it, so a second request arriving in the same tick finds it.
        const compute = (async () => {
            // Both ladders, one round trip each, inside the SAME cached payload. Rule (10)
            // of the multiplayer notes: the community strip is one endpoint, because the
            // request budget is per IP and shared behind a Radmin NAT — a second route would
            // cost double for a page nobody asked twice for.
            // Both are the CURRENT season's: a season that has just begun shows an empty table,
            // which is the reset as a player sees it. Ended seasons are /stats/season/:n.
            const [leaderboard, leaderboard_team, ranked_players, ranked_players_team] =
                await Promise.all([
                    ladder(ctx, 'default', limit, season),
                    ladder(ctx, 'team', limit, season),
                    ladderSize(ctx, 'default', season),
                    ladderSize(ctx, 'team', season),
                ]);

            // Source is lobbies.created_at, and the wording on the card has to match:
            // this is when people OPEN ROOMS, not when they play. Rooms are stamped by
            // the server (datetime('now'), UTC) and their rows are never deleted, while
            // matches.started_at is written by the client and only exists for the few
            // games that got reported at all.
            const hourRows = await ctx.db.prepare(
                `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS h, COUNT(*) AS c
                 FROM lobbies
                 WHERE created_at >= datetime('now', ?)${modSql}
                 GROUP BY h`,
            ).bind(`-${ACTIVITY_WINDOW_DAYS} days`, ...modArgs).all<HourRow>();

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
            // `matches` counts EVERY match of the window, rated or not; `rated` counts the ones
            // that actually moved a rating. Two numbers and not one, because the launcher used to
            // print the first and call it the second — and the gap between them is the interesting
            // part: it is how many games the server could not read a result from.
            //
            // `rated` is the only count in this file that filters on `matches.rated`. That column
            // and `unrated_reason` have existed since migration 0006 and no endpoint read either.
            const totals = await ctx.db.prepare(
                `SELECT
                    (SELECT COUNT(*) FROM matches m
                      WHERE m.created_at >= datetime('now', ?)${modSql}${modeSql})  AS matches,
                    (SELECT COUNT(*) FROM matches m
                      WHERE m.created_at >= datetime('now', ?)${modSql}${modeSql}
                        AND m.rated = 1)                                            AS rated,
                    (SELECT COUNT(*) FROM users
                      WHERE last_seen_at >= datetime('now', ?))            AS players`,
            ).bind(
                `-${ACTIVITY_WINDOW_DAYS} days`, ...modArgs,
                `-${ACTIVITY_WINDOW_DAYS} days`, ...modArgs,
                `-${ACTIVE_PLAYERS_WINDOW_DAYS} days`,
            ).first<TotalsRow>();

            // WHY the rest did not count, most common first. One reason is worth more than a
            // number: "16 did not count" invites a bug report, "16 did not count, mostly
            // no_decided_result" is a fact somebody can act on.
            const unratedRows = await ctx.db.prepare(
                `SELECT COALESCE(m.unrated_reason, 'unknown') AS reason, COUNT(*) AS n
                   FROM matches m
                  WHERE m.created_at >= datetime('now', ?)${modSql}${modeSql}
                    AND m.rated = 0
                  GROUP BY reason
                  ORDER BY n DESC, reason ASC
                  LIMIT 1`,
            ).bind(`-${ACTIVITY_WINDOW_DAYS} days`, ...modArgs)
                .first<{ reason: string; n: number }>();

            // One row per day of the window, days with no matches included as zero. A community
            // this size cannot see a trend in a single total, and a gap in the series would read
            // as missing data rather than as a quiet day.
            const perDayRows = await ctx.db.prepare(
                `SELECT date(m.created_at) AS day, COUNT(*) AS n
                   FROM matches m
                  WHERE m.created_at >= datetime('now', ?)${modSql}${modeSql}
                  GROUP BY day
                  ORDER BY day ASC`,
            ).bind(`-${ACTIVITY_WINDOW_DAYS} days`, ...modArgs)
                .all<{ day: string; n: number }>();

            // The whole list, and the singular below is its head. See TOP_MAPS_SQL for why that is
            // one query and not two. Same `limit` the ladders take, so a caller asking for a bigger
            // page gets a bigger page of everything.
            const topMapRows = await ctx.db.prepare(topMapsSql(mod, mode))
                .bind(`-${ACTIVITY_WINDOW_DAYS} days`, ...modArgs, limit).all<TopMapRow>();

            const top_maps = (topMapRows.results ?? []).map(r => ({ map: r.map_name, matches: r.n }));
            const topMap = topMapRows.results?.[0] ?? null;

            // The community's last few matches — everyone's, not the caller's. The strip is
            // headed "community activity" and used to fill this from the viewer's own history,
            // so a player who had never played saw an empty panel with nothing to suggest
            // anyone else was here.
            //
            // EVERY COLUMN IS QUALIFIED because of the join below: `lobbies` also has `id`,
            // `mod_id` and `created_at`, so an unqualified name here is ambiguous - including
            // the interpolated mod filter, which is why it reads `m.mod_id`.
            //
            // `l.competitive` is what the ROOM was and `m.rated` is whether it scored; they are
            // different questions and a competitive match can be unrated. The flag is on the
            // lobby on purpose (migration 0007) so a client can never claim it, hence the join
            // rather than a column on `matches`. LEFT: `lobby_id` is nullable and old rows may
            // point at nothing, which yields NULL - "we don't know", never "casual".
            const recentRows = await ctx.db.prepare(
                `SELECT m.id, m.mod_id, m.map_name, m.duration_seconds,
                        m.created_at AS reported_at,
                        m.rated, m.unrated_reason,
                        l.competitive
                   FROM matches m
                   LEFT JOIN lobbies l ON l.id = m.lobby_id
                  ${mod ? 'WHERE m.mod_id = ?' : ''}
                  ORDER BY m.created_at DESC
                  LIMIT ?`,
            ).bind(...modArgs, recent)
                .all<Record<string, unknown> & { id: string }>();

            // Coerced to real booleans, NULL preserved - see the identical block in
            // /matches/history for why a raw SQLite 1 takes a whole page down on the client.
            const recent_matches = (recentRows.results ?? []).map((m) => ({
                ...m,
                rated: m.rated == null ? null : Boolean(m.rated),
                competitive: m.competitive == null ? null : Boolean(m.competitive),
            }));
            // The same helper the history endpoint uses, so "who played" is assembled one way
            // in this codebase: one query for the whole page, never one per match.
            await attachParticipants(ctx, recent_matches);

            // 2v2 against 3v3. Nothing stores a format, so it is derived by counting participants
            // and sides per match - the same shape /matches/history derives player_count from. It
            // is asked only in team mode: in 1v1 the answer is "every match is 1v1".
            const formatRows = mode === 'team'
                ? await ctx.db.prepare(
                    `SELECT players, COUNT(*) AS matches FROM (
                         SELECT mp.match_id AS id, COUNT(*) AS players
                           FROM match_participants mp
                           JOIN matches m ON m.id = mp.match_id
                          WHERE m.created_at >= datetime('now', ?)${modSql}${modeSql}
                          GROUP BY mp.match_id)
                      GROUP BY players
                      ORDER BY players ASC`,
                ).bind(`-${ACTIVITY_WINDOW_DAYS} days`, ...modArgs)
                    .all<{ players: number; matches: number }>()
                : { results: [] as { players: number; matches: number }[] };

            const payload = {
                generated_at: new Date(now).toISOString(),
                min_decided: MIN_DECIDED,
                mode,
                // Which season the two ladders below belong to, when it ends, and every season
                // so far — what the launcher's season selector and its end-of-season notice are
                // built from. An older launcher ignores it; a newer one against an older server
                // reads null and offers no selector.
                season: seasonBlock(now),
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
                // Which mod this whole payload is about, echoed back. The launcher draws it beside
                // the figures; without it a cached page and a fresh one are indistinguishable.
                mod: mod,
                totals: {
                    window_days: ACTIVITY_WINDOW_DAYS,
                    matches: totals?.matches ?? 0,
                    // The subset that moved a rating, and the commonest reason the rest did not.
                    rated: totals?.rated ?? 0,
                    unrated_top_reason: unratedRows?.reason ?? null,
                    unrated_top_reason_matches: unratedRows?.n ?? 0,
                    // The window, day by day. Zero-filled by the client, which knows its own
                    // calendar; the server sends only the days it has.
                    matches_per_day: (perDayRows.results ?? []).map(
                        r => ({ day: r.day, matches: r.n })),
                    // Empty outside team mode, where the question does not arise.
                    team_formats: (formatRows.results ?? []).map(
                        r => ({ players: r.players, matches: r.matches })),
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

            const done = Date.now();
            communityCache.set(key, { at: done, payload });
            pruneCommunityCache(done);
            return payload;
        })();

        communityInFlight.set(key, compute);
        try {
            reply.header('Cache-Control', 'public, max-age=60');
            return await compute;
        } finally {
            // Always, including on a throw: a failed computation must not wedge the key
            // so that every later request awaits a promise that already rejected.
            communityInFlight.delete(key);
        }
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
    }, async (req, reply) => {
        // Rows already carried `mod_id`, and the launcher drew all of them: with two mods, or
        // two builds of one mod, the same civilization appeared twice with different numbers
        // and nothing said why. Filtering here rather than there is what makes that
        // impossible instead of unlikely.
        const mod = modParam(req);
        const mode = modeParam(req);
        const modSql = modClause(mod).sql.replace('mod_id', 'm.mod_id') + modeClause(mode);
        const modArgs = modClause(mod).args;

        const now = Date.now();
        if (civCache && civCache.mod === mod && civCache.mode === mode
            && now - civCache.at < CACHE_TTL_MS) {
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
                AND m.rated = 1${modSql}
              GROUP BY m.mod_id, m.mod_combined_hash, mp.civ
             HAVING played >= ?
              ORDER BY played DESC, mp.civ ASC
              LIMIT ?`,
        ).bind(...modArgs, CIV_MIN_PLAYED, CIV_LIMIT).all<{
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
                AND m.rated = 1${modSql}`,
        ).bind(...modArgs).first<{ n: number }>();

        // The denominator for the figure above, on the SAME terms — rated, 1v1, this mod, all
        // time. The launcher printed "0 of 42", pairing this all-time count with a
        // thirty-day total from another endpoint; two windows in one sentence.
        const rated = await ctx.db.prepare(
            `SELECT COUNT(*) AS n
               FROM matches m
              WHERE m.rated = 1${modSql}`,
        ).bind(...modArgs).first<{ n: number }>();

        const payload = {
            generated_at: new Date(now).toISOString(),
            // How many matches contributed anything at all. The launcher says it out loud above
            // the table: with civilizations only reported from one build onwards, "nothing here
            // yet" is the honest state for a while and a blank table would read as broken.
            rated_matches_with_civ: matched?.n ?? 0,
            // Same filter minus the civilization, so the two are comparable by construction.
            rated_matches: rated?.n ?? 0,
            mod,
            mode,
            civs,
        };

        civCache = { at: now, mod, mode, payload };
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
    }, async (req, reply) => {
        const mod = modParam(req);
        const mode = modeParam(req);
        const now = Date.now();
        if (matchupCache && matchupCache.mod === mod && matchupCache.mode === mode
            && now - matchupCache.at < CACHE_TTL_MS) {
            reply.header('Cache-Control', 'public, max-age=60');
            return matchupCache.payload;
        }

        interface PairRow {
            mod_id: string;
            mod_combined_hash: string;
            civ_a: string;
            civ_b: string;
            played: number;
            wins_a: number;
            losses_a: number;
        }

        const read = async (side: 'rivals' | 'allies') => {
            const r = await ctx.db.prepare(matchupsSql(mod, mode, side))
                .bind(...modClause(mod).args, MATCHUP_MIN_PLAYED, MATCHUP_LIMIT).all<PairRow>();
            return (r.results ?? []).map((x) => ({
                mod_id: x.mod_id,
                mod_version: x.mod_combined_hash,
                civ_a: x.civ_a,
                civ_b: x.civ_b,
                played: x.played,
                wins_a: x.wins_a,
                losses_a: x.losses_a,
            }));
        };

        const matchups = await read('rivals');

        // Who a civilization is played WITH. Only in team games: in a 1v1 nobody has an ally,
        // and the query would come back empty every time. Served in the same payload rather
        // than behind a second route, because the request budget is per IP and shared behind
        // a Radmin NAT - the same reason the community strip is one endpoint.
        const allies = mode === 'team' ? await read('allies') : [];

        const payload = {
            generated_at: new Date(now).toISOString(),
            mod,
            mode,
            matchups,
            allies,
        };

        matchupCache = { at: now, mod, mode, payload };
        reply.header('Cache-Control', 'public, max-age=60');
        return payload;
    });

    /**
     * WHICH MODS HAVE DATA, so a launcher can offer them without being told in code.
     *
     * <p>This is the route that makes "add a mod to the catalog and it just works" true. The
     * launcher's mod picker used to list the mods installed on that machine, so a newly
     * catalogued mod stayed invisible until somebody installed it — and its statistics existed
     * on the server the whole time. Now the picker takes the union of this list and the
     * installed ones.</p>
     *
     * <p>No mod is named anywhere: the answer is whatever `matches.mod_id` holds. A mod starts
     * appearing the moment somebody plays one game of it, and stops when it falls out of the
     * window, with no deploy on either side.</p>
     *
     * <p>Rides the community rate-limit scope rather than a fourth one: it is fetched once
     * beside `/stats/community` and never on its own.</p>
     */
    app.get('/stats/mods', {
        preHandler: [ipRateLimit(ctx, Limits.StatsPublicIp)],
    }, async (_req, reply) => {
        const now = Date.now();
        if (modsCache && now - modsCache.at < CACHE_TTL_MS) {
            reply.header('Cache-Control', 'public, max-age=60');
            return modsCache.payload;
        }

        const rows = await ctx.db.prepare(
            `SELECT mod_id,
                    COUNT(*) AS matches,
                    SUM(CASE WHEN rated = 1 THEN 1 ELSE 0 END) AS rated,
                    SUM(CASE WHEN rating_mode = 'team' THEN 1 ELSE 0 END) AS team
               FROM matches
              WHERE created_at >= datetime('now', ?)
              GROUP BY mod_id
              ORDER BY matches DESC, mod_id ASC`,
        ).bind(`-${ACTIVITY_WINDOW_DAYS} days`)
            .all<{ mod_id: string; matches: number; rated: number; team: number }>();

        const payload = {
            generated_at: new Date(now).toISOString(),
            window_days: ACTIVITY_WINDOW_DAYS,
            mods: (rows.results ?? []).map(r => ({
                mod_id: r.mod_id,
                matches: r.matches,
                rated: r.rated,
                // How many were team games, which is how the launcher decides whether to offer
                // a 1v1/team switch for this mod at all. Zero means the switch would only ever
                // lead to an empty page, and an empty page is not a choice worth showing.
                // Only `'team'` counts: NULL is a pre-0010 1v1, never a team game.
                team: r.team ?? 0,
            })),
        };

        modsCache = { at: now, payload };
        reply.header('Cache-Control', 'public, max-age=60');
        return payload;
    });

    /**
     * Which cards the community brings. See {@link DECK_CARDS_SQL}; this only serves it.
     */
    app.get('/stats/decks', {
        preHandler: [ipRateLimit(ctx, Limits.StatsDecksIp)],
    }, async (req, reply) => {
        const mod = modParam(req);
        const now = Date.now();
        if (deckCache && deckCache.mod === mod && now - deckCache.at < CACHE_TTL_MS) {
            reply.header('Cache-Control', 'public, max-age=60');
            return deckCache.payload;
        }

        const rows = await ctx.db.prepare(deckCardsSql(mod))
            .bind(...modClause(mod).args, DECK_MIN_PLAYERS, DECK_LIMIT).all<{
                mod_id: string; civ: string; card: string; players: number;
            }>();

        // Counted, never derived by summing the rows: a player contributes to many cards, so
        // any arithmetic over the list above would report a multiple of the real headcount —
        // and the launcher prints this figure above the table.
        //
        // Scoped to the mod when one was asked for, or the launcher would print "12 people
        // contributed" over a table holding one mod's cards out of three mods' contributors.
        const contributors = await ctx.db.prepare(
            `SELECT COUNT(DISTINCT user_id) AS n FROM deck_cards${mod ? ' WHERE mod_id = ?' : ''}`,
        ).bind(...modClause(mod).args).first<{ n: number }>();

        const payload = {
            generated_at: new Date(now).toISOString(),
            contributors: contributors?.n ?? 0,
            mod,
            cards: rows.results ?? [],
        };

        deckCache = { at: now, mod, payload };
        reply.header('Cache-Control', 'public, max-age=60');
        return payload;
    });

    /**
     * An ENDED season's final tables, both ladders — what the ranking shows when a past season
     * is picked in its selector.
     *
     * <p>Only ended seasons: the running one is `/stats/community`, and answering it here too
     * would give the launcher two sources for one table. A season that has not ended is a 404,
     * which the launcher reads as "nothing to show", never as an error.</p>
     *
     * <p>Memoised for five minutes per (season, limit) rather than for good: an ended season
     * cannot change by itself, but an operator correction run from `scripts/admin.ts` replays
     * from that season in ANOTHER process, which no in-memory memo here could hear about.</p>
     */
    app.get('/stats/season/:n', {
        preHandler: [ipRateLimit(ctx, Limits.StatsSeasonIp)],
    }, async (req, reply) => {
        const n = parseInt((req.params as { n?: string }).n ?? '', 10);
        const query = req.query as { limit?: string } | undefined;
        const parsed = query?.limit ? parseInt(query.limit, 10) : MAX_LIMIT;
        const limit = Number.isFinite(parsed) ? Math.min(MAX_LIMIT, Math.max(1, parsed)) : MAX_LIMIT;

        const now = Date.now();
        if (!Number.isFinite(n) || n < 1 || !isClosed(n, now)) throw Errors.NotFound('Season');

        const key = `${n}\u0000${limit}`;
        const hit = seasonCache.get(key);
        if (hit && now - hit.at < SEASON_CACHE_TTL_MS) {
            reply.header('Cache-Control', 'public, max-age=300');
            return hit.payload;
        }

        const [leaderboard, leaderboard_team, ranked_players, ranked_players_team] =
            await Promise.all([
                seasonTable(ctx, n, 'default', limit, now),
                seasonTable(ctx, n, 'team', limit, now),
                seasonTableSize(ctx, n, 'default', now),
                seasonTableSize(ctx, n, 'team', now),
            ]);

        const bounds = seasonBounds(n);
        const payload = {
            generated_at: new Date(now).toISOString(),
            season: n,
            starts_at: bounds.start === null ? null : new Date(bounds.start).toISOString(),
            ends_at: new Date(bounds.end).toISOString(),
            min_decided: MIN_DECIDED,
            leaderboard,
            leaderboard_team,
            ranked_players,
            ranked_players_team,
        };

        for (const [k, v] of seasonCache) {
            if (now - v.at >= SEASON_CACHE_TTL_MS) seasonCache.delete(k);
        }
        seasonCache.set(key, { at: now, payload });
        reply.header('Cache-Control', 'public, max-age=300');
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
