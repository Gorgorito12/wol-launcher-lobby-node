// `glicko2` is a CJS module; importing the default gives us the
// constructor under <c>.Glicko2</c> regardless of how the bundler
// unwraps the module. Same approach the Worker used.
import glicko2 from 'glicko2';
import type { Db } from '../db';

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
 * These are not a placeholder standing in for a real answer: a player with no row
 * in `elo_ratings` genuinely IS 1500/350, which is why `applyMatch` below already
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
 * The ladder a match belongs to. `elo_ratings` is keyed by (user_id, mode) and has
 * carried this since 0001_initial for exactly this purpose; 2v2 and 3v3 share
 * `'team'` because splitting a scarce category would leave both halves permanently
 * provisional against the leaderboard's `rd <= 110`.
 */
export type RatingMode = 'default' | 'team';

interface EloRow {
    user_id: string;
    rating: number;
    rd: number;
    volatility: number;
    games_played: number;
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

export async function applyMatch(
    db: Db,
    outcomes: ParticipantOutcome[],
    mode: RatingMode = 'default',
): Promise<Map<string, { before: number; after: number; rdBefore: number; rdAfter: number }>> {
    if (outcomes.length < 2) return new Map();

    const ranking = new Glicko2Ctor({ tau: 0.5, rating: DEFAULT_RATING, rd: DEFAULT_RD, vol: DEFAULT_VOLATILITY });

    const ids = outcomes.map((o) => o.userId);
    const placeholders = ids.map(() => '?').join(',');
    const existing = await db.prepare(
        `SELECT user_id, rating, rd, volatility, games_played
         FROM elo_ratings WHERE user_id IN (${placeholders}) AND mode = ?`,
    ).bind(...ids, mode).all<EloRow>();

    const byId = new Map<string, EloRow>();
    for (const row of existing.results ?? []) byId.set(row.user_id, row);

    const players = new Map<string, ReturnType<typeof ranking.makePlayer>>();
    const before = new Map<string, { rating: number; rd: number }>();
    for (const o of outcomes) {
        const row = byId.get(o.userId);
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
            `INSERT INTO elo_ratings (user_id, mode, rating, rd, volatility, games_played, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
             ON CONFLICT (user_id, mode) DO UPDATE SET
               rating = excluded.rating,
               rd = excluded.rd,
               volatility = excluded.volatility,
               games_played = elo_ratings.games_played + 1,
               updated_at = datetime('now')`,
        ).bind(o.userId, mode, after, rdAfter, volAfter));
    }

    await db.batch(writes);
    return diff;
}
