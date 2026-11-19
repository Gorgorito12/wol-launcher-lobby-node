/**
 * What a ranked match is worth to each player BEFORE it is played (2026-11-18): "if you win +8,
 * if you lose −17" — the chess sites' stake, here exactly the figure the result card will show.
 *
 * <p><b>Equal by construction, not by parallel code.</b> Both branches are
 * {@link rateOutcome} — the very function `rateStoredMatch` rates the match with — run once as a
 * win for side A and once as a win for side B, on fresh effective ratings and the same anti-farm
 * chain (src/elo/ladder.ts previewOutcomes). So the discount is in the figure: a third win in a
 * row against the same rival is worth 90 % here as it will be on the card. What can still move it
 * by a point is time (RD grows between Start and the report), stated to the player.</p>
 *
 * <p><b>Unrounded on the wire.</b> The launcher rounds with the result card's own rule
 * (MatchOutcomeView.Delta, away from zero); rounding here too would let −16.5 read −16 before the
 * match and −17 after it.</p>
 *
 * <p><b>Privacy: a stake gives the rival's rating back</b> (the ratio of the two figures is the
 * expected score). So a viewer gets no figures while ANY other player of the match — rival or
 * teammate — is hidden from him (`ratingHiddenFrom`: being placed, or a private rating; private
 * named first, as `roomOdds` does). The one placing or private himself still sees HIS figures
 * when everybody else is public: they depend only on his own rating and public ones. Pure; pinned
 * by stake.test.ts, where the refusals are the point.</p>
 */
import { rateOutcome, type OutcomeInput } from './outcome';
import { ratingHiddenFrom } from './placementPrivacy';
import { isRatingPrivate } from './ratingPrivacy';
import type { RatingMode } from './glicko2';

export interface StakeBranch {
    after: number;
    factor: number;
    /** The anti-farm streak this result would store (null in a tournament). */
    streak: number | null;
}

export interface PlayerStake {
    before: number;
    win: StakeBranch;
    loss: StakeBranch;
    /** His side's chance of winning, 1-99. */
    winPct: number | null;
}

/** Both outcomes for every player: side A wins, then side B wins. */
export function matchStakes(input: Omit<OutcomeInput, 'scoreA' | 'scoreB'>): Map<string, PlayerStake> {
    const aWins = rateOutcome({ ...input, scoreA: 1, scoreB: 0 });
    const bWins = rateOutcome({ ...input, scoreA: 0, scoreB: 1 });
    const out = new Map<string, PlayerStake>();
    const add = (ids: readonly { id: string }[], win: typeof aWins, loss: typeof aWins) => {
        for (const { id } of ids) {
            const w = win.perPlayer.get(id)!;
            const l = loss.perPlayer.get(id)!;
            out.set(id, {
                before: w.before,
                win: { after: w.after, factor: win.factor, streak: win.streak },
                loss: { after: l.after, factor: loss.factor, streak: loss.streak },
                winPct: w.winExpected,
            });
        }
    };
    add(input.sideA, aWins, bWins);
    add(input.sideB, bWins, aWins);
    return out;
}

export type StakeHiddenReason = 'placement' | 'private';

/** Why this viewer may not see a stake: another player of the match is hidden from him. */
export function stakeHiddenFrom(
    viewerId: string,
    players: readonly { id: string; gamesPlayed?: number | null }[],
    mode: RatingMode,
): StakeHiddenReason | null {
    const others = players.filter((p) => p.id !== viewerId);
    if (others.some((p) => isRatingPrivate(p.id))) return 'private';
    if (others.some((p) => ratingHiddenFrom(viewerId, p.id, p.gamesPlayed, mode))) return 'placement';
    return null;
}

/** What one viewer receives. Keys are omitted, never null; hidden = mode, seq, reason only. */
export interface RoomStake {
    mode: RatingMode;
    seq?: number;
    before?: number;
    win_after?: number;
    loss_after?: number;
    win_pct?: number;
    win_factor?: number;
    loss_factor?: number;
    win_streak?: number;
    loss_streak?: number;
    tournament?: boolean;
    final?: boolean;
    hidden_reason?: StakeHiddenReason;
}

/**
 * The stake one viewer is sent. Null for somebody who is not one of the players (a spectator) or
 * when nothing was computed. A factor below 1 is sent with its streak (the launcher's amber note);
 * a full-value branch sends neither.
 */
export function roomStakeFor(
    viewerId: string,
    stakes: ReadonlyMap<string, PlayerStake> | null,
    players: readonly { id: string; gamesPlayed?: number | null }[],
    mode: RatingMode,
    opts: { tournament: boolean; final?: boolean; seq?: number },
): RoomStake | null {
    if (!stakes || !players.some((p) => p.id === viewerId)) return null;
    const base: RoomStake = { mode };
    if (opts.seq !== undefined) base.seq = opts.seq;
    const hidden = stakeHiddenFrom(viewerId, players, mode);
    if (hidden) return { ...base, hidden_reason: hidden };
    const s = stakes.get(viewerId);
    if (!s) return null;
    const out: RoomStake = { ...base, before: s.before, win_after: s.win.after, loss_after: s.loss.after };
    if (s.winPct !== null) out.win_pct = s.winPct;
    if (s.win.factor < 1) {
        out.win_factor = s.win.factor;
        if (s.win.streak !== null) out.win_streak = s.win.streak;
    }
    if (s.loss.factor < 1) {
        out.loss_factor = s.loss.factor;
        if (s.loss.streak !== null) out.loss_streak = s.loss.streak;
    }
    if (opts.tournament) out.tournament = true;
    if (opts.final) out.final = true;
    return out;
}
