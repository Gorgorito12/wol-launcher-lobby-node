/**
 * TOURNAMENT PERFORMANCE (2026-11-18): the rating a player played at during his run — the one at
 * which the Glicko expectation over his counted games equals the score he made, solved by
 * bisection with each rival's rating and RD AS THEY WERE at that game (`rating_before`,
 * `rd_before`; a game stored before migration 0035 uses the plain curve, RD 0).
 *
 * <p>A perfect or zero score has no finite answer, so it is capped at the rivals' mean ± 400 and
 * flagged ('above' / 'below'): in single elimination the champion always scores 100 %, so the cap
 * IS his figure. FIDE's 800 would print a number far above the whole ladder.</p>
 *
 * <p>Pure. What counts (played and rated on the tournament's ladder: no walkovers, DQs, byes or
 * organiser decisions) and who may see it are decided by the caller (src/tournaments/rest.ts).</p>
 */
import { DEFAULT_RATING, SCALE, expected } from '../elo/glicko2';

export const PERFORMANCE_CAP = 400;
export const PERFORMANCE_MIN_GAMES = 2;

export interface PerformanceGame {
    /** The rival side's mean rating at the time of the game. */
    oppRating: number;
    /** The rival side's deviation at the time (combined for a team), or null when not stored. */
    oppRd: number | null;
    /** 1 won, 0 lost (0.5 never reaches a bracket). */
    score: number;
    /** Who the rival was, for "best win". */
    oppName: string;
}

export interface Performance {
    /** Null under {@link PERFORMANCE_MIN_GAMES} counted games. */
    rating: number | null;
    capped: 'above' | 'below' | null;
    games: number;
    best_win: { name: string; rating: number } | null;
}

function scoreAt(rating: number, games: readonly PerformanceGame[]): number {
    const mu = (rating - DEFAULT_RATING) / SCALE;
    let sum = 0;
    for (const g of games) {
        sum += expected(mu, (g.oppRating - DEFAULT_RATING) / SCALE, (g.oppRd ?? 0) / SCALE);
    }
    return sum;
}

export function tournamentPerformance(games: readonly PerformanceGame[]): Performance | null {
    if (games.length === 0) return null;
    const wins = games.filter((g) => g.score >= 0.999);
    const best = wins.reduce<PerformanceGame | null>((a, g) => (!a || g.oppRating > a.oppRating ? g : a), null);
    const best_win = best ? { name: best.oppName, rating: Math.round(best.oppRating) } : null;
    if (games.length < PERFORMANCE_MIN_GAMES) return { rating: null, capped: null, games: games.length, best_win };

    const mean = games.reduce((s, g) => s + g.oppRating, 0) / games.length;
    const lo = mean - PERFORMANCE_CAP;
    const hi = mean + PERFORMANCE_CAP;
    const score = games.reduce((s, g) => s + g.score, 0);
    if (score >= games.length - 1e-9) return { rating: Math.round(hi), capped: 'above', games: games.length, best_win };
    if (score <= 1e-9) return { rating: Math.round(lo), capped: 'below', games: games.length, best_win };

    if (scoreAt(hi, games) <= score) return { rating: Math.round(hi), capped: 'above', games: games.length, best_win };
    if (scoreAt(lo, games) >= score) return { rating: Math.round(lo), capped: 'below', games: games.length, best_win };
    let a = lo;
    let b = hi;
    for (let i = 0; i < 60; i++) {
        const m = (a + b) / 2;
        if (scoreAt(m, games) < score) a = m; else b = m;
    }
    return { rating: Math.round((a + b) / 2), capped: null, games: games.length, best_win };
}
