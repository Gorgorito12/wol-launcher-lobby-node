// `glicko2` is a CJS module; importing the default gives us the
// constructor under <c>.Glicko2</c> regardless of how the bundler
// unwraps the module. Same approach the Worker used.
import glicko2 from 'glicko2';
import type { Db } from '../db';
import { softReset } from './seasons';

const Glicko2Ctor = (glicko2 as unknown as { Glicko2: typeof import('glicko2').Glicko2 }).Glicko2
    ?? (glicko2 as unknown as { default: { Glicko2: typeof import('glicko2').Glicko2 } }).default?.Glicko2
    ?? (glicko2 as unknown as typeof import('glicko2')).Glicko2;

/**
 * Glicko-2 rating wrapper.
 *
 * Same domain logic as the Worker version: load existing ratings,
 * build a player object per participant, apply every pairwise outcome
 * in one rating-period update, persist the new ratings back. Identical
 * SQL → identical numeric behaviour, so a user's ELO survives the
 * migration unchanged.
 */
/**
 * What an UNRATED player is worth. Glicko's own starting point, and the single
 * source for it — it used to be typed out at each site, which is how the surfaces
 * came to disagree about the same player.
 *
 * These are not a placeholder standing in for a real answer: a player who has never
 * played a rated match genuinely IS 1500/350, which is why `applyMatch` below already
 * rates their first match as if they were. Every endpoint that reports a rating
 * fills these in for such a player, so `null` on the wire keeps ONE meaning — no
 * answer (an older server, a query that failed) — and never "this player is worth
 * nothing".
 */
export const DEFAULT_RATING = 1500;
export const DEFAULT_RD = 350;
export const DEFAULT_VOLATILITY = 0.06;

export interface ParticipantOutcome {
    userId: string;
    result: 0 | 0.5 | 1;
    /**
     * Which side this player was on, for a team match. Absent (or the same value for
     * everyone) means there are no sides, which is every 1v1 and every match reported
     * before teams existed.
     *
     * It is what stops two teammates being fed to Glicko as a game against each other —
     * see the pairing loop, where it is the whole difference.
     */
    team?: number;
}

/**
 * The ladder a match belongs to. Ratings have been keyed by mode since 0001_initial for
 * exactly this purpose; 2v2 and 3v3 share `'team'` because splitting a scarce category would
 * leave both halves permanently provisional against the leaderboard's `rd <= 110`.
 */
export type RatingMode = 'default' | 'team';

/**
 * What a player is worth on one ladder in one season — the number every surface shows and the
 * number his next match there starts from. They are the SAME number by construction, because
 * {@link applyMatch} reads through the same helper every reader does.
 */
export interface EffectiveRating {
    rating: number;
    rd: number;
    volatility: number;
    /** Rated matches on this ladder in THIS season. 0 for a carried or a brand-new player. */
    games_played: number;
    /**
     * Where the number came from: the player's row for this season, the soft reset of the last
     * season he played, or nothing at all (the Glicko-2 defaults).
     */
    source: 'season' | 'carried' | 'default';
}

interface SeasonRow {
    user_id: string;
    season: number;
    rating: number;
    rd: number;
    volatility: number;
    games_played: number;
}

/**
 * Every row that could decide a player's effective rating in `season`: his row for that season,
 * and every EARLIER one he actually played in. One query for any number of players.
 *
 * <p>Binds: mode, season, season, then the user ids.</p>
 */
export function effectiveRatingsSql(userCount: number): string {
    const marks = Array.from({ length: userCount }, () => '?').join(', ');
    return `SELECT user_id, season, rating, rd, volatility, games_played
              FROM season_ratings
             WHERE mode = ? AND season <= ? AND (season = ? OR games_played > 0)
               AND user_id IN (${marks})`;
}

/**
 * The rule, pure: this season's row if there is one; else the soft reset of the most recent
 * earlier season with games; else the defaults. A player who skipped a season carries from the
 * last one he played, ONCE — skipping does not compound the reset.
 *
 * <p>Every id asked about gets an answer, so a caller never has to tell "no row" from "not
 * asked".</p>
 */
export function pickEffective(
    rows: readonly SeasonRow[],
    season: number,
    userIds: readonly string[],
): Map<string, EffectiveRating> {
    const own = new Map<string, SeasonRow>();
    const carried = new Map<string, SeasonRow>();
    for (const r of rows) {
        if (r.season === season) { own.set(r.user_id, r); continue; }
        if (r.season > season || r.games_played <= 0) continue;
        const prev = carried.get(r.user_id);
        if (!prev || r.season > prev.season) carried.set(r.user_id, r);
    }

    const out = new Map<string, EffectiveRating>();
    for (const id of userIds) {
        const mine = own.get(id);
        if (mine) {
            out.set(id, {
                rating: mine.rating, rd: mine.rd, volatility: mine.volatility,
                games_played: mine.games_played, source: 'season',
            });
            continue;
        }
        const from = carried.get(id);
        if (from) {
            out.set(id, { ...softReset(from), games_played: 0, source: 'carried' });
            continue;
        }
        out.set(id, {
            rating: DEFAULT_RATING, rd: DEFAULT_RD, volatility: DEFAULT_VOLATILITY,
            games_played: 0, source: 'default',
        });
    }
    return out;
}

/**
 * The effective rating of several players on one ladder in one season — THE reader. Every
 * surface that shows a rating, and {@link applyMatch} itself, goes through this, so the number on
 * screen at the start of a season is exactly the number the player's first match starts from.
 *
 * <p>Throws on a database error. Callers that must not fail (a room's hello, the players panel)
 * catch it and send no rating, which the launcher reads as "unknown" — never as somebody's
 * starting 1500.</p>
 */
export async function effectiveRatings(
    db: Db,
    userIds: readonly string[],
    mode: RatingMode,
    season: number,
): Promise<Map<string, EffectiveRating>> {
    const unique = [...new Set(userIds.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const rows = await db.prepare(effectiveRatingsSql(unique.length))
        .bind(mode, season, season, ...unique)
        .all<SeasonRow>();
    return pickEffective(rows.results ?? [], season, unique);
}

/**
 * Whether two participants were on opposite sides.
 *
 * <b>This is the fix for the one thing in this file that was actively wrong.</b> The
 * pairing loop below used to face everybody against everybody and decide each pair by
 * comparing `result` — so two teammates, who by definition carry the SAME result, were
 * handed to Glicko as a draw between themselves. Measured: 1900 + 1100 beating
 * 1500 + 1500 gave the 1100 **+354** and the 1900 **−36**, because the 1100 had
 * "drawn" with a 1900.
 *
 * A match with no sides — every 1v1, and every row written before teams existed —
 * answers true for every pair, so its pairing is byte-for-byte what it always was.
 * That equivalence is the property to protect.
 */
function areOpponents(a: ParticipantOutcome, b: ParticipantOutcome): boolean {
    if (a.team === undefined || b.team === undefined) return true;
    return a.team !== b.team;
}

/**
 * Rate one match on one ladder, in the season the match belongs to.
 *
 * <p><b>`season` is required, and it is the season of the MATCH</b> — derived from the row's own
 * `matches.created_at` (see `matchSeason`), never from the clock at the moment of rating. A team
 * match stored at 05:58 on the last day of a season and corroborated at 06:02 is a match of the
 * season that just ended; the callers check that season is still open before they get here.</p>
 *
 * <p>The starting point comes from {@link effectiveRatings}: this season's row, else the soft
 * reset of the last season the player played. Reading BEFORE the batch matters — `Db.batch` only
 * writes — and so does reading through the shared helper: the `rating_before` this stamps on a
 * player's first match of a season is exactly the number his profile showed the moment before.</p>
 */
export async function applyMatch(
    db: Db,
    outcomes: ParticipantOutcome[],
    mode: RatingMode,
    season: number,
): Promise<Map<string, { before: number; after: number; rdBefore: number; rdAfter: number }>> {
    if (outcomes.length < 2) return new Map();

    const ranking = new Glicko2Ctor({ tau: 0.5, rating: DEFAULT_RATING, rd: DEFAULT_RD, vol: DEFAULT_VOLATILITY });

    const current = await effectiveRatings(db, outcomes.map((o) => o.userId), mode, season);

    const players = new Map<string, ReturnType<typeof ranking.makePlayer>>();
    const before = new Map<string, { rating: number; rd: number }>();
    for (const o of outcomes) {
        const row = current.get(o.userId);
        const r = row?.rating ?? DEFAULT_RATING;
        const rd = row?.rd ?? DEFAULT_RD;
        const vol = row?.volatility ?? DEFAULT_VOLATILITY;
        players.set(o.userId, ranking.makePlayer(r, rd, vol));
        before.set(o.userId, { rating: r, rd });
    }

    const matches: Array<[ReturnType<typeof ranking.makePlayer>, ReturnType<typeof ranking.makePlayer>, number]> = [];
    for (let i = 0; i < outcomes.length; i++) {
        for (let j = i + 1; j < outcomes.length; j++) {
            const a = outcomes[i]!;
            const b = outcomes[j]!;
            // Teammates are not opponents. Skipping them is the entire team fix: what is
            // left is each player facing every player on the other side, which in a 2v2
            // is two games per person in one rating period.
            if (!areOpponents(a, b)) continue;
            const ra = players.get(a.userId)!;
            const rb = players.get(b.userId)!;
            let outcomeForA: number;
            if (a.result === b.result) outcomeForA = 0.5;
            else if (a.result > b.result) outcomeForA = 1;
            else outcomeForA = 0;
            matches.push([ra, rb, outcomeForA]);
        }
    }
    ranking.updateRatings(matches);

    const diff = new Map<string, { before: number; after: number; rdBefore: number; rdAfter: number }>();
    const writes = [];
    for (const o of outcomes) {
        const p = players.get(o.userId)!;
        const bf = before.get(o.userId)!;
        const after = p.getRating();
        const rdAfter = p.getRd();
        const volAfter = p.getVol();
        diff.set(o.userId, { before: bf.rating, after, rdBefore: bf.rd, rdAfter });
        writes.push(db.prepare(
            `INSERT INTO season_ratings
                 (user_id, mode, season, rating, rd, volatility, games_played, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))
             ON CONFLICT (user_id, mode, season) DO UPDATE SET
               rating = excluded.rating,
               rd = excluded.rd,
               volatility = excluded.volatility,
               games_played = season_ratings.games_played + 1,
               updated_at = datetime('now')`,
        ).bind(o.userId, mode, season, after, rdAfter, volAfter));
    }

    await db.batch(writes);
    return diff;
}
