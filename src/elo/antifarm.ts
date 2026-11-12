/**
 * Anti-farm: a win over the same opponent again and again is worth less and less, for BOTH
 * players.
 *
 * <p><b>The rule.</b> Consecutive wins of the same side over the same opponent (in a team game,
 * the exact same matchup: the same two sets of players):</p>
 * <ul>
 *   <li>1st and 2nd win in a row: 100 % of the rating change;</li>
 *   <li>3rd: 90 %, then 10 points less per win: 80, 70, 60, 50, 40, 30;</li>
 *   <li>from the 10th: 20 %, the minimum.</li>
 * </ul>
 * <p>The streak goes back to the start (100 %) the moment the other side wins one, and recovers
 * 10 % for every full 24 hours the pair spends without playing each other. It applies during
 * placement too, and never to a tournament game: a bracket decides who plays whom, so a repeated
 * pairing there is not a choice. Tournament games are invisible to the chain — they neither count
 * towards it nor break it.</p>
 *
 * <p><b>Both players are scaled</b>, because farming needs a willing (or second) account on the
 * losing side: shrinking only the winner's gain would leave the loser free to feed points
 * indefinitely at full price.</p>
 *
 * <p>Pure. The chain is walked from STORED rows (`matches.farm_streak`, `farm_winner_key`,
 * `created_at`), so a replay of the history reproduces every factor exactly.</p>
 */

export const FARM_FREE_WINS = 2;
export const FARM_STEP = 0.1;
export const FARM_MIN_FACTOR = 0.2;
/** The streak at which the factor reaches its minimum; it never needs to count past it. */
export const FARM_CAP = 10;
/** One step of recovery per this much time without the pair playing each other. */
export const FARM_RECOVERY_MS = 24 * 60 * 60 * 1000;

/** A side's identity: its players' ids, sorted, joined. Order-free by construction. */
export function sideKey(ids: readonly string[]): string {
    return [...ids].sort().join(',');
}

/** The exact matchup: the ladder plus both sides' keys, sorted. Who won is NOT part of it. */
export function matchupKey(mode: string, sides: readonly (readonly string[])[]): string {
    return `${mode}:${sides.map((s) => sideKey(s)).sort().join('|')}`;
}

function round2(x: number): number {
    return Math.round(x * 100) / 100;
}

/** The factor for an effective streak: 1 up to {@link FARM_FREE_WINS}, then 10 % less per win. */
export function factorForStreak(streak: number): number {
    if (streak <= FARM_FREE_WINS) return 1;
    return Math.max(FARM_MIN_FACTOR, round2(1 - FARM_STEP * (streak - FARM_FREE_WINS)));
}

/** The previous match of the same matchup, as stored. */
export interface FarmLink {
    atMs: number;
    /** The effective streak stored on that match. */
    streak: number;
    /** Who won it; null for a draw. */
    winnerKey: string | null;
}

export interface FarmInput {
    atMs: number;
    winnerKey: string | null;
    isTournament: boolean;
}

export interface FarmStep {
    factor: number;
    /** The effective streak to store. Null for a tournament game, which the chain skips. */
    streak: number | null;
}

/**
 * The factor for THIS match, from the previous one of the same matchup (null when there is none).
 *
 * <p>The streak counts the winner's consecutive wins, minus one for every full 24 h since the
 * previous match of the pair, and never below 1 (this match is itself a win). A long enough break
 * therefore resets it entirely. It saturates at {@link FARM_CAP}, so recovery from the minimum is
 * always one step per day.</p>
 */
export function antifarmStep(prev: FarmLink | null, cur: FarmInput): FarmStep {
    if (cur.isTournament) return { factor: 1, streak: null };
    if (cur.winnerKey === null) return { factor: 1, streak: 0 };
    let streak = 1;
    if (prev && prev.winnerKey === cur.winnerKey && prev.streak > 0) {
        const days = Math.floor(Math.max(0, cur.atMs - prev.atMs) / FARM_RECOVERY_MS);
        streak = Math.max(1, Math.min(FARM_CAP, prev.streak + 1) - days);
    }
    return { factor: factorForStreak(streak), streak };
}
