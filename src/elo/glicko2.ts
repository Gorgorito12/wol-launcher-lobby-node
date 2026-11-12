/**
 * Glicko-2, Lichess-style: pure maths, no I/O.
 *
 * <p><b>Why our own implementation and not the npm `glicko2` package this file used to wrap.</b>
 * That library's `update_rank()` always applies step 6 of Glickman's algorithm (the one-period
 * increase of the deviation on every update) and has no switch to turn it off, and its expected
 * score is always computed from the player's OWN rating. The rules this ladder runs on need both
 * things the library cannot express: no per-match period increase (Lichess's
 * `skipDeviationIncrease`), and a team player's expectation computed from his TEAM's mean.</p>
 *
 * <p><b>The rules</b> (Glickman, "Example of the Glicko-2 system", 2013, plus three Lichess
 * choices):</p>
 * <ul>
 *   <li>τ 0.75; a new player starts at 1500 / RD 500 / volatility 0.09.</li>
 *   <li>RD is clamped to [45, 500]; volatility to at most 0.1.</li>
 *   <li><b>Uncertainty grows with time, not with matches.</b> Before a match, the deviation is
 *       grown by the time since the player's last rated match on that ladder:
 *       φ* = √(φ² + t·σ²), with t = 0.21436 rating periods per day ({@link decayRd}). After the
 *       update there is NO extra period (step 6 is skipped). Lichess folds the elapsed periods into
 *       step 6 with the NEW σ'; doing it before the update with the old σ is Glickman's own
 *       "decay the prior periods first", and it keeps a house invariant: the RD a reader shows
 *       is exactly the RD the next match starts from.</li>
 *   <li>The rating never falls below 400, and one match never moves it more than ±700
 *       ({@link applyLimits}).</li>
 * </ul>
 *
 * <p>Every function here is deterministic and takes its clock from the caller, which is what lets
 * a replay of the whole history reproduce the live ladder exactly.</p>
 */

/** Glickman's scale factor between the Glicko-1 and Glicko-2 scales. */
export const SCALE = 173.7178;

export const TAU = 0.75;

/**
 * What an UNRATED player is worth. Glicko's own starting point, and the single source for it.
 * A player who has never played a rated match genuinely IS 1500/500, which is why the engine
 * rates his first match as if he were; `null` on the wire keeps ONE meaning: no answer.
 */
export const DEFAULT_RATING = 1500;
export const DEFAULT_RD = 500;
export const DEFAULT_VOLATILITY = 0.09;

export const MIN_RD = 45;
export const MAX_RD = 500;
export const MAX_VOLATILITY = 0.1;

/** Rating periods per day of inactivity: how fast uncertainty comes back (Lichess's value). */
export const RATING_PERIODS_PER_DAY = 0.21436;

/** Nobody is ever rated below this. */
export const RATING_FLOOR = 400;

/** The most one match may move a rating, either way. */
export const MAX_DELTA = 700;

const VOL_EPSILON = 1e-6;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ParticipantOutcome {
    userId: string;
    result: 0 | 0.5 | 1;
    /** Which side this player was on. Absent for a 1v1. */
    team?: number;
}

/**
 * The ladder a match belongs to. 2v2 and 3v3 share `'team'`: splitting a scarce category would
 * leave both halves permanently thin.
 */
export type RatingMode = 'default' | 'team';

/** A player's state as the engine sees it, on the Glicko-1 scale. */
export interface GlickoState {
    rating: number;
    rd: number;
    volatility: number;
}

function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

export function clampRd(rd: number): number {
    return clamp(rd, MIN_RD, MAX_RD);
}

export function g(phi: number): number {
    return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

/** Expected score of `mu` against an opponent at `muOpp` with deviation `phiOpp` (Glicko-2 scale). */
export function expected(mu: number, muOpp: number, phiOpp: number): number {
    return 1 / (1 + Math.exp(-g(phiOpp) * (mu - muOpp)));
}

/**
 * Grow a deviation by the time since the player's last rated match: φ* = √(φ² + t·σ²), clamped.
 * A negative or missing elapsed time grows nothing.
 */
export function decayRd(rd: number, volatility: number, elapsedMs: number): number {
    const t = (Math.max(0, elapsedMs || 0) / DAY_MS) * RATING_PERIODS_PER_DAY;
    const phi = rd / SCALE;
    const grown = Math.sqrt(phi * phi + t * volatility * volatility) * SCALE;
    return clampRd(grown);
}

/** Step 5 of Glickman 2013: the new volatility, by the Illinois algorithm. */
export function newVolatility(phi: number, sigma: number, v: number, delta: number, tau: number = TAU): number {
    const a = Math.log(sigma * sigma);
    const phi2 = phi * phi;
    const f = (x: number): number => {
        const ex = Math.exp(x);
        return (ex * (delta * delta - phi2 - v - ex)) / (2 * Math.pow(phi2 + v + ex, 2))
            - (x - a) / (tau * tau);
    };

    let A = a;
    let B: number;
    if (delta * delta > phi2 + v) {
        B = Math.log(delta * delta - phi2 - v);
    } else {
        let k = 1;
        while (f(a - k * tau) < 0) k++;
        B = a - k * tau;
    }
    let fA = f(A);
    let fB = f(B);
    let guard = 0;
    while (Math.abs(B - A) > VOL_EPSILON && guard++ < 200) {
        const C = A + ((A - B) * fA) / (fB - fA);
        const fC = f(C);
        if (fC * fB <= 0) {
            A = B;
            fA = fB;
        } else {
            fA = fA / 2;
        }
        B = C;
        fB = fC;
    }
    return Math.min(MAX_VOLATILITY, Math.exp(A / 2));
}

/** One game in a rating period, from one player's point of view (Glicko-2 scale). */
export interface PeriodGame {
    /** The rating the expectation is computed FROM: the player's own μ, or his team's mean. */
    muSelf: number;
    muOpp: number;
    phiOpp: number;
    score: number;
}

/**
 * The general Glickman update over any number of games in one period. The ladder always calls it
 * with ONE game and `periodIncrease: false`; the general form exists so a test can pin Glickman's
 * own worked example (three games, τ 0.5, step 6 applied).
 *
 * <p>`state.rd` must already be the deviation AT the moment of the match (see {@link decayRd}).</p>
 */
export function updateMany(
    state: GlickoState,
    games: readonly PeriodGame[],
    opts: { tau?: number; periodIncrease?: boolean } = {},
): GlickoState {
    const tau = opts.tau ?? TAU;
    const mu = (state.rating - DEFAULT_RATING) / SCALE;
    const phi = state.rd / SCALE;
    if (games.length === 0) return { ...state };

    let vInv = 0;
    let sum = 0;
    for (const gm of games) {
        const gp = g(gm.phiOpp);
        const e = expected(gm.muSelf, gm.muOpp, gm.phiOpp);
        vInv += gp * gp * e * (1 - e);
        sum += gp * (gm.score - e);
    }
    const v = 1 / vInv;
    const delta = v * sum;

    const sigmaPrime = newVolatility(phi, state.volatility, v, delta, tau);
    const phiStar = opts.periodIncrease ? Math.sqrt(phi * phi + sigmaPrime * sigmaPrime) : phi;
    const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
    const muPrime = mu + phiPrime * phiPrime * sum;

    return {
        rating: muPrime * SCALE + DEFAULT_RATING,
        rd: phiPrime * SCALE,
        volatility: sigmaPrime,
    };
}

/**
 * One side's combined deviation: the root mean square of its players' RDs.
 *
 * <p>RMS rather than √(Σrd²)/n, which shrinks with the team's size (three newcomers at 500 would
 * read as 289, overconfident, and differently for 2v2 and 3v3 on one shared ladder), and rather
 * than the plain mean, which under-weights one newcomer among veterans.</p>
 */
export function combinedRd(rds: readonly number[]): number {
    if (rds.length === 0) return DEFAULT_RD;
    const meanSq = rds.reduce((s, r) => s + r * r, 0) / rds.length;
    return Math.sqrt(meanSq);
}

function mean(xs: readonly number[]): number {
    return xs.length === 0 ? DEFAULT_RATING : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** A player as {@link rateSides} needs him: rating and volatility as stored, RD already decayed. */
export interface SidePlayer extends GlickoState {
    id: string;
}

export interface Side {
    players: readonly SidePlayer[];
    /** 1 won, 0 lost, 0.5 draw. */
    score: number;
}

/**
 * Rate a match between two sides, "team against team".
 *
 * <p>Every player of a side is updated against the OTHER side's mean rating and combined RD, with
 * his expectation computed from his OWN side's mean, so every teammate faces the same odds. How
 * far he moves comes from his own deviation and volatility: a newcomer on a winning team gains
 * more than the veteran beside him, both in the same direction.</p>
 *
 * <p>A 1v1 is two one-player sides, and then this is exactly standard Glicko-2.</p>
 *
 * <p>Returns the RAW new state per player; the anti-farm factor, the ±700 cap and the floor are
 * {@link applyLimits}'s.</p>
 */
export function rateSides(a: Side, b: Side): Map<string, GlickoState> {
    const out = new Map<string, GlickoState>();
    const sides: Array<[Side, Side]> = [[a, b], [b, a]];
    for (const [own, opp] of sides) {
        const muOwn = (mean(own.players.map((p) => p.rating)) - DEFAULT_RATING) / SCALE;
        const muOpp = (mean(opp.players.map((p) => p.rating)) - DEFAULT_RATING) / SCALE;
        const phiOpp = combinedRd(opp.players.map((p) => p.rd)) / SCALE;
        for (const p of own.players) {
            const next = updateMany(p, [{ muSelf: muOwn, muOpp, phiOpp, score: own.score }]);
            out.set(p.id, {
                rating: next.rating,
                rd: clampRd(next.rd),
                volatility: Math.min(MAX_VOLATILITY, next.volatility),
            });
        }
    }
    return out;
}

/**
 * The rating a player actually ends on: the change scaled by the anti-farm factor, then capped at
 * ±{@link MAX_DELTA}, then floored at {@link RATING_FLOOR}. That order is deliberate: the factor
 * describes how much the match was WORTH, the cap and the floor are limits on the outcome.
 */
export function applyLimits(before: number, rawAfter: number, factor: number = 1): number {
    const scaled = (rawAfter - before) * factor;
    const delta = clamp(scaled, -MAX_DELTA, MAX_DELTA);
    return Math.max(RATING_FLOOR, before + delta);
}

/**
 * The chance, as a whole percent between 1 and 99, that side A beats side B — Glicko's own
 * prediction, from each side's mean rating and combined deviation:
 * P = 1 / (1 + e^(−g(√(φA² + φB²))·(μA − μB))). Null when either side is empty.
 *
 * <p>The launcher never computes this: it shows what the server sends.</p>
 */
export function winProbability(
    a: readonly { rating: number; rd: number }[],
    b: readonly { rating: number; rd: number }[],
): { a: number; b: number } | null {
    if (a.length === 0 || b.length === 0) return null;
    const muA = (mean(a.map((p) => p.rating)) - DEFAULT_RATING) / SCALE;
    const muB = (mean(b.map((p) => p.rating)) - DEFAULT_RATING) / SCALE;
    const phiA = combinedRd(a.map((p) => p.rd)) / SCALE;
    const phiB = combinedRd(b.map((p) => p.rd)) / SCALE;
    const phi = Math.sqrt(phiA * phiA + phiB * phiB);
    const p = 1 / (1 + Math.exp(-g(phi) * (muA - muB)));
    const pa = clamp(Math.round(p * 100), 1, 99);
    return { a: pa, b: 100 - pa };
}
