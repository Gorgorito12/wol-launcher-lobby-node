/**
 * One player's standing on one ladder: the numbers the Profile's mode card and its "against each
 * opponent" table are drawn from (design 55d-55f), and the room's "your record 9–2" (55g).
 *
 * <p>Everything here is derived ON READ from the player's rated matches — streaks, peak and low,
 * head-to-head — so nothing needs a timer and nothing can drift from the history it describes. A
 * player's rated history on one ladder is small (tens to a few hundred rows), so this is cheap.</p>
 *
 * <p><b>`placement_results` is the player's own business.</b> The ladder shows OTHER players'
 * placement progress in grey with no wins or losses, and the server never sends another player's
 * results: the caller passes `self` only when the request is authenticated as that player.</p>
 */
import type { AppContext } from '../context';
import { WIN_AT, LOSS_AT } from '../elo/ratability';
import { effectiveRatings } from '../elo/ladder';
import { isInactive, placementRequired } from '../elo/placement';
import { streakSummary } from '../elo/streaks';
import { normaliseSqliteTimestamp, sqliteTimestampToMs } from '../lib/time';
import type { RatingMode } from '../elo/glicko2';
import { ladderRanks, ladderSize } from './rest';

/** How many opponents the head-to-head list carries; `head_to_head_total` says how many exist. */
export const HEAD_TO_HEAD_LIMIT = 50;

export interface HeadToHead {
    user_id: string;
    display_name: string;
    avatar_url: string | null;
    wins: number;
    losses: number;
    last_at: string;
}

export interface PlacementResult {
    match_id: string;
    result: number;
    rating_after: number;
    at: string;
}

export interface LadderStanding {
    rating: number;
    rd: number;
    volatility: number;
    games_played: number;
    /** Position among ranked players; 0 = not ranked (placement); omitted on failure. */
    ladder_rank?: number;
    ladder_size?: number;
    placement_played: number;
    placement_required: number;
    placement_results?: PlacementResult[];
    inactive: boolean;
    last_rated_at: string | null;
    wins: number;
    losses: number;
    streak_current: number;
    streak_best: number;
    loss_streak_best: number;
    streak_ended_at: string | null;
    rating_peak: number | null;
    rating_peak_at: string | null;
    rating_low: number | null;
    rating_low_at: string | null;
    head_to_head: HeadToHead[];
    head_to_head_total: number;
}

export interface RatedRow {
    match_id: string;
    created_at: string;
    result: number;
    rating_before: number | null;
    rating_after: number | null;
}

export interface RefundPoint {
    created_at: string;
    rating_after: number;
}

/**
 * Peak and low, pure: every rating the player held AFTER finishing placement — the rating after
 * his N-th rated match (N = the requirement) and every later one, plus the ratings refunds gave
 * him from then on. Null until placement is finished: a newcomer's first matches swing hundreds of
 * points by design, and "your peak was your second game" says nothing.
 */
export function peakAndLow(
    rows: readonly RatedRow[],
    refunds: readonly RefundPoint[],
    required: number,
): { peak: number | null; peakAt: string | null; low: number | null; lowAt: string | null } {
    if (rows.length < required) return { peak: null, peakAt: null, low: null, lowAt: null };
    const points: Array<{ at: string; rating: number }> = [];
    const placedAt = rows[required - 1]!.created_at;
    for (let i = required - 1; i < rows.length; i++) {
        const r = rows[i]!;
        if (r.rating_after !== null) points.push({ at: r.created_at, rating: r.rating_after });
    }
    for (const f of refunds) if (f.created_at >= placedAt) points.push({ at: f.created_at, rating: f.rating_after });
    if (points.length === 0) return { peak: null, peakAt: null, low: null, lowAt: null };
    let peak = points[0]!;
    let low = points[0]!;
    for (const p of points) {
        // Strict comparisons: the FIRST time a value was reached is its date.
        if (p.rating > peak.rating) peak = p;
        if (p.rating < low.rating) low = p;
    }
    return {
        peak: peak.rating, peakAt: normaliseSqliteTimestamp(peak.at),
        low: low.rating, lowAt: normaliseSqliteTimestamp(low.at),
    };
}

export async function standingFor(
    ctx: AppContext,
    userId: string,
    mode: RatingMode,
    nowMs: number,
    opts: { self: boolean },
): Promise<LadderStanding> {
    const required = placementRequired(mode);
    const eff = (await effectiveRatings(ctx.db, [userId], mode, nowMs)).get(userId)!;

    const rowsRes = await ctx.db.prepare(
        `SELECT m.id AS match_id, m.created_at, p.result, p.rating_before, p.rating_after
           FROM matches m JOIN match_participants p ON p.match_id = m.id
          WHERE p.user_id = ? AND m.rated = 1 AND COALESCE(m.rating_mode, 'default') = ?
          ORDER BY m.created_at ASC, m.id ASC`,
    ).bind(userId, mode).all<RatedRow>();
    const rows = rowsRes.results ?? [];

    const refundsRes = await ctx.db.prepare(
        `SELECT b.created_at, r.rating_after
           FROM rating_refunds r JOIN ban_refunds b ON b.id = r.refund_id
          WHERE r.user_id = ? AND r.mode = ? AND b.revoked_at IS NULL
          ORDER BY b.created_at ASC`,
    ).bind(userId, mode).all<RefundPoint>();

    const streak = streakSummary(
        rows.map((r) => ({ atMs: sqliteTimestampToMs(r.created_at) ?? 0, result: r.result })), nowMs);
    const extremes = peakAndLow(rows, refundsRes.results ?? [], required);

    const wins = rows.filter((r) => r.result >= WIN_AT).length;
    const losses = rows.filter((r) => r.result <= LOSS_AT).length;

    const h2h = await ctx.db.prepare(
        `SELECT b.user_id AS user_id, u.display_name AS display_name, u.avatar_url AS avatar_url,
                SUM(CASE WHEN a.result >= ? THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN a.result <= ? THEN 1 ELSE 0 END) AS losses,
                MAX(m.created_at) AS last_at, COUNT(*) AS n
           FROM match_participants a
           JOIN matches m ON m.id = a.match_id
           JOIN match_participants b ON b.match_id = m.id AND b.user_id <> a.user_id
           JOIN users u ON u.id = b.user_id
          WHERE a.user_id = ? AND m.rated = 1 AND COALESCE(m.rating_mode, 'default') = ?
            AND (COALESCE(m.rating_mode, 'default') = 'default' OR b.team <> a.team)
          GROUP BY b.user_id
          ORDER BY n DESC, last_at DESC
          LIMIT ?`,
    ).bind(WIN_AT, LOSS_AT, userId, mode, HEAD_TO_HEAD_LIMIT).all<HeadToHead & { n: number }>();
    const h2hTotal = await ctx.db.prepare(
        `SELECT COUNT(DISTINCT b.user_id) AS n
           FROM match_participants a
           JOIN matches m ON m.id = a.match_id
           JOIN match_participants b ON b.match_id = m.id AND b.user_id <> a.user_id
          WHERE a.user_id = ? AND m.rated = 1 AND COALESCE(m.rating_mode, 'default') = ?
            AND (COALESCE(m.rating_mode, 'default') = 'default' OR b.team <> a.team)`,
    ).bind(userId, mode).first<{ n: number }>();

    const rank = (await ladderRanks(ctx, [userId], mode)).get(userId);
    let size: number | undefined;
    try { size = await ladderSize(ctx, mode); } catch { size = undefined; }

    const last = eff.last_rated_at;
    const standing: LadderStanding = {
        rating: eff.rating,
        rd: eff.rd,
        volatility: eff.volatility,
        games_played: eff.games_played,
        ladder_rank: rank,
        ladder_size: size,
        placement_played: Math.min(eff.games_played, required),
        placement_required: required,
        inactive: isInactive(sqliteTimestampToMs(last), nowMs),
        last_rated_at: last ? normaliseSqliteTimestamp(last) : null,
        wins,
        losses,
        streak_current: streak.current,
        streak_best: streak.best,
        loss_streak_best: streak.lossBest,
        streak_ended_at: streak.endedAt === null ? null : new Date(streak.endedAt).toISOString(),
        rating_peak: extremes.peak,
        rating_peak_at: extremes.peakAt,
        rating_low: extremes.low,
        rating_low_at: extremes.lowAt,
        head_to_head: (h2h.results ?? []).map((r) => ({
            user_id: r.user_id,
            display_name: r.display_name,
            avatar_url: r.avatar_url,
            wins: r.wins ?? 0,
            losses: r.losses ?? 0,
            last_at: normaliseSqliteTimestamp(r.last_at),
        })),
        head_to_head_total: h2hTotal?.n ?? 0,
    };
    if (opts.self) {
        standing.placement_results = rows.slice(0, required).map((r) => ({
            match_id: r.match_id,
            result: r.result,
            rating_after: r.rating_after ?? 0,
            at: normaliseSqliteTimestamp(r.created_at),
        }));
    }
    return standing;
}

export interface RefundNotice {
    refund_id: string;
    mode: string;
    points: number;
    matches: number;
    rating_before: number;
    rating_after: number;
    created_at: string;
    seen: boolean;
}

/** A player's refunds, newest first. Only ever sent to that player; never names the banned one. */
export async function refundsFor(ctx: AppContext, userId: string): Promise<RefundNotice[]> {
    const rows = await ctx.db.prepare(
        `SELECT r.refund_id, r.mode, r.points, r.matches, r.rating_before, r.rating_after,
                b.created_at, r.seen_at
           FROM rating_refunds r JOIN ban_refunds b ON b.id = r.refund_id
          WHERE r.user_id = ? AND b.revoked_at IS NULL
          ORDER BY b.created_at DESC
          LIMIT 20`,
    ).bind(userId).all<{
        refund_id: string; mode: string; points: number; matches: number;
        rating_before: number; rating_after: number; created_at: string; seen_at: string | null;
    }>();
    return (rows.results ?? []).map((r) => ({
        refund_id: r.refund_id,
        mode: r.mode === 'team' ? 'team' : 'default',
        points: Math.round(r.points),
        matches: r.matches,
        rating_before: r.rating_before,
        rating_after: r.rating_after,
        created_at: normaliseSqliteTimestamp(r.created_at),
        seen: r.seen_at !== null,
    }));
}
