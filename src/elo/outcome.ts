/**
 * What one match does to every player in it, as a PURE function — the core of
 * `rateStoredMatch` (src/elo/ladder.ts), moved here so the pre-match stake
 * (src/elo/stake.ts) and the real rating are the SAME computation, not two that agree by care.
 *
 * <p>Input: both sides with each player's rating, RD already grown to the instant
 * (`effectiveRatings`) and volatility; the two scores; the previous match of the same matchup for
 * the anti-farm chain (or null); and whether it is a tournament game. Output: the anti-farm
 * verdict and, per player, before / after (factor, cap and floor applied), the RDs, the new
 * volatility and his side's chance of winning, as a whole percent, from the ratings BEFORE the
 * match — the figure the result card explains the points with.</p>
 */
import { applyLimits, rateSides, winProbability, type RatingMode, type SidePlayer } from './glicko2';
import { antifarmStep, matchupKey, sideKey, type FarmLink } from './antifarm';
import { WIN_AT } from './ratability';

export interface OutcomeInput {
    mode: RatingMode;
    sideA: readonly SidePlayer[];
    sideB: readonly SidePlayer[];
    scoreA: number;
    scoreB: number;
    /** The previous rated, non-tournament match of this matchup; null when there is none. */
    prev: FarmLink | null;
    atMs: number;
    isTournament: boolean;
}

export interface OutcomePlayer {
    before: number;
    after: number;
    rdBefore: number;
    rdAfter: number;
    volatilityAfter: number;
    /** His side's chance of winning, 1-99, from the ratings before the match. */
    winExpected: number | null;
}

export interface Outcome {
    factor: number;
    streak: number | null;
    winnerKey: string | null;
    matchupKey: string;
    perPlayer: Map<string, OutcomePlayer>;
}

/** The matchup key of two sides, as the anti-farm chain stores it. */
export function matchupOf(mode: RatingMode, sideA: readonly { id: string }[], sideB: readonly { id: string }[]): string {
    return matchupKey(mode, [sideA.map((p) => p.id), sideB.map((p) => p.id)]);
}

export function rateOutcome(i: OutcomeInput): Outcome {
    const keyA = sideKey(i.sideA.map((p) => p.id));
    const keyB = sideKey(i.sideB.map((p) => p.id));
    const winnerKey = i.scoreA >= WIN_AT ? keyA : i.scoreB >= WIN_AT ? keyB : null;
    const farm = antifarmStep(i.prev, { atMs: i.atMs, winnerKey, isTournament: i.isTournament });

    const raw = rateSides({ players: i.sideA, score: i.scoreA }, { players: i.sideB, score: i.scoreB });
    const odds = winProbability(i.sideA, i.sideB);

    const perPlayer = new Map<string, OutcomePlayer>();
    const add = (players: readonly SidePlayer[], pct: number | null) => {
        for (const p of players) {
            const r = raw.get(p.id)!;
            perPlayer.set(p.id, {
                before: p.rating,
                after: applyLimits(p.rating, r.rating, farm.factor),
                rdBefore: p.rd,
                rdAfter: r.rd,
                volatilityAfter: r.volatility,
                winExpected: pct,
            });
        }
    };
    add(i.sideA, odds?.a ?? null);
    add(i.sideB, odds?.b ?? null);

    return {
        factor: farm.factor,
        streak: farm.streak,
        winnerKey,
        matchupKey: matchupOf(i.mode, i.sideA, i.sideB),
        perPlayer,
    };
}
