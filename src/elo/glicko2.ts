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
export interface ParticipantOutcome {
    userId: string;
    result: 0 | 0.5 | 1;
}

interface EloRow {
    user_id: string;
    rating: number;
    rd: number;
    volatility: number;
    games_played: number;
}

export async function applyMatch(
    db: Db,
    outcomes: ParticipantOutcome[],
): Promise<Map<string, { before: number; after: number; rdBefore: number; rdAfter: number }>> {
    if (outcomes.length < 2) return new Map();

    const ranking = new Glicko2Ctor({ tau: 0.5, rating: 1500, rd: 350, vol: 0.06 });

    const ids = outcomes.map((o) => o.userId);
    const placeholders = ids.map(() => '?').join(',');
    const existing = await db.prepare(
        `SELECT user_id, rating, rd, volatility, games_played
         FROM elo_ratings WHERE user_id IN (${placeholders}) AND mode = 'default'`,
    ).bind(...ids).all<EloRow>();

    const byId = new Map<string, EloRow>();
    for (const row of existing.results ?? []) byId.set(row.user_id, row);

    const players = new Map<string, ReturnType<typeof ranking.makePlayer>>();
    const before = new Map<string, { rating: number; rd: number }>();
    for (const o of outcomes) {
        const row = byId.get(o.userId);
        const r = row?.rating ?? 1500;
        const rd = row?.rd ?? 350;
        const vol = row?.volatility ?? 0.06;
        players.set(o.userId, ranking.makePlayer(r, rd, vol));
        before.set(o.userId, { rating: r, rd });
    }

    const matches: Array<[ReturnType<typeof ranking.makePlayer>, ReturnType<typeof ranking.makePlayer>, number]> = [];
    for (let i = 0; i < outcomes.length; i++) {
        for (let j = i + 1; j < outcomes.length; j++) {
            const a = outcomes[i]!;
            const b = outcomes[j]!;
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
             VALUES (?, 'default', ?, ?, ?, 1, datetime('now'))
             ON CONFLICT (user_id, mode) DO UPDATE SET
               rating = excluded.rating,
               rd = excluded.rd,
               volatility = excluded.volatility,
               games_played = elo_ratings.games_played + 1,
               updated_at = datetime('now')`,
        ).bind(o.userId, after, rdAfter, volAfter));
    }

    await db.batch(writes);
    return diff;
}
