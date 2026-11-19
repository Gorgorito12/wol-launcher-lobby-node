/**
 * The ladder's state and the ONE function that rates a match.
 *
 * <p><b>{@link effectiveRatings} is THE reader.</b> Every surface that shows a rating, and the
 * rating of a match itself, goes through it, so the number on screen is exactly the number the
 * player's next match starts from — including the deviation, which it grows to the moment asked
 * about (src/elo/glicko2.ts, decayRd).</p>
 *
 * <p><b>{@link rateStoredMatch} is the ONLY writer.</b> All seven live paths that rate a match (the
 * report, a late reading, a late abandonment, a team match the other side confirms, a founded
 * match, and the two that undo one through a replay) and the replay itself call it with a match
 * id, and it reads everything it needs from STORED rows: the match's own `created_at` (never the
 * clock), its participants and their results, whether it belonged to a tournament, and the
 * previous match of the same matchup for the anti-farm chain. That is what makes a replay of the
 * whole history reproduce the live ladder by construction rather than by care.</p>
 *
 * <p>Every call on the server goes through `withLadderLock` (src/elo/replay.ts).</p>
 */
import type { Db } from '../db';
import { sqliteTimestampToMs } from '../lib/time';
import {
    decayRd, DEFAULT_RATING, DEFAULT_RD, DEFAULT_VOLATILITY,
    type RatingMode, type SidePlayer,
} from './glicko2';
import { type FarmLink } from './antifarm';
import { refundTotals, type RefundLossRow } from './refunds';
import { matchupOf, rateOutcome } from './outcome';

/** What a player is worth on one ladder at one instant. */
export interface EffectiveRating {
    rating: number;
    /** The deviation AT the instant asked about: grown by the time since `last_rated_at`. */
    rd: number;
    volatility: number;
    /** Rated matches on this ladder, all time. */
    games_played: number;
    /** `matches.created_at` of the last rated match on this ladder; null if none. */
    last_rated_at: string | null;
    /** A stored row, or nothing at all (the Glicko-2 defaults). */
    source: 'rated' | 'default';
}

interface RatingRow {
    user_id: string;
    rating: number;
    rd: number;
    volatility: number;
    games_played: number;
    last_rated_at: string | null;
}

/** Binds: mode, then the user ids. */
export function effectiveRatingsSql(userCount: number): string {
    const marks = Array.from({ length: userCount }, () => '?').join(', ');
    return `SELECT user_id, rating, rd, volatility, games_played, last_rated_at
              FROM player_ratings
             WHERE mode = ? AND user_id IN (${marks})`;
}

/** The pure half: a stored row (or none) at an instant. */
export function effectiveFromRow(row: RatingRow | undefined, atMs: number): EffectiveRating {
    if (!row) {
        return {
            rating: DEFAULT_RATING, rd: DEFAULT_RD, volatility: DEFAULT_VOLATILITY,
            games_played: 0, last_rated_at: null, source: 'default',
        };
    }
    const last = sqliteTimestampToMs(row.last_rated_at);
    return {
        rating: row.rating,
        rd: last === null ? row.rd : decayRd(row.rd, row.volatility, atMs - last),
        volatility: row.volatility,
        games_played: row.games_played,
        last_rated_at: row.last_rated_at,
        source: 'rated',
    };
}

/**
 * The effective rating of several players on one ladder at `atMs` (default: now). Every id asked
 * about gets an answer. Throws on a database error; callers that must not fail catch it and send
 * no rating, which the launcher reads as "unknown".
 */
export async function effectiveRatings(
    db: Db,
    userIds: readonly string[],
    mode: RatingMode,
    atMs: number = Date.now(),
): Promise<Map<string, EffectiveRating>> {
    const unique = [...new Set(userIds.filter(Boolean))];
    const out = new Map<string, EffectiveRating>();
    if (unique.length === 0) return out;
    const rows = await db.prepare(effectiveRatingsSql(unique.length))
        .bind(mode, ...unique)
        .all<RatingRow>();
    const byId = new Map((rows.results ?? []).map((r) => [r.user_id, r] as [string, RatingRow]));
    for (const id of unique) out.set(id, effectiveFromRow(byId.get(id), atMs));
    return out;
}

/** One player's change from one match. */
export interface PlayerChange {
    before: number;
    after: number;
    rdBefore: number;
    rdAfter: number;
    /** Rated matches on this ladder INCLUDING this one. */
    gamesAfter: number;
    /** His side's chance of winning, 1-99, from the ratings before the match. */
    winExpected: number | null;
}

export interface RatedMatch {
    eloFactor: number;
    farmStreak: number | null;
    matchupKey: string;
    perPlayer: Map<string, PlayerChange>;
}

interface ParticipantRow {
    user_id: string;
    team: number;
    result: number;
}

/** The two sides of a stored match, or null for a shape the engine does not rate. Pure. */
export function sidesOf(
    rows: readonly ParticipantRow[],
    mode: RatingMode,
): [ParticipantRow[], ParticipantRow[]] | null {
    if (mode === 'default') {
        if (rows.length !== 2) return null;
        return [[rows[0]!], [rows[1]!]];
    }
    const byTeam = new Map<number, ParticipantRow[]>();
    for (const r of rows) {
        const t = r.team | 0;
        const list = byTeam.get(t) ?? [];
        list.push(r);
        byTeam.set(t, list);
    }
    if (byTeam.size !== 2) return null;
    const [a, b] = [...byTeam.entries()].sort((x, y) => x[0] - y[0]).map(([, v]) => v);
    return [a!, b!];
}

/**
 * Which earlier matches the anti-farm chain reads — ONE filter, shared by the engine
 * ({@link PREV_MATCHUP_SQL}) and the pre-match stake ({@link LATEST_MATCHUP_SQL}) so the two
 * cannot drift. Binds: the matchup key.
 */
export const MATCHUP_CHAIN_WHERE =
    `matchup_key = ? AND rated = 1 AND elo_factor IS NOT NULL AND tournament_match_id IS NULL`;

/** The previous rated, non-tournament match of the same matchup, strictly before this one. */
export const PREV_MATCHUP_SQL =
    `SELECT created_at, farm_streak, farm_winner_key FROM matches
      WHERE ${MATCHUP_CHAIN_WHERE} AND id <> ?
        AND (created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC
      LIMIT 1`;

/** The latest one: what a match played NOW would follow (the stake). */
export const LATEST_MATCHUP_SQL =
    `SELECT created_at, farm_streak, farm_winner_key FROM matches
      WHERE ${MATCHUP_CHAIN_WHERE}
      ORDER BY created_at DESC, id DESC
      LIMIT 1`;

type ChainRow = { created_at: string; farm_streak: number | null; farm_winner_key: string | null };

function farmLinkOf(row: ChainRow | null | undefined): FarmLink | null {
    const at = sqliteTimestampToMs(row?.created_at ?? null);
    return row && at !== null ? { atMs: at, streak: row.farm_streak ?? 0, winnerKey: row.farm_winner_key } : null;
}

export const UPSERT_RATING_SQL =
    `INSERT INTO player_ratings
         (user_id, mode, rating, rd, volatility, games_played, last_rated_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, datetime('now'))
     ON CONFLICT (user_id, mode) DO UPDATE SET
       rating = excluded.rating,
       rd = excluded.rd,
       volatility = excluded.volatility,
       games_played = player_ratings.games_played + 1,
       last_rated_at = CASE
           WHEN player_ratings.last_rated_at IS NULL
             OR excluded.last_rated_at > player_ratings.last_rated_at
           THEN excluded.last_rated_at ELSE player_ratings.last_rated_at END,
       updated_at = datetime('now')`;

/**
 * Rate one stored match on its ladder. Reads only stored rows (see the file comment) and writes,
 * in ONE batch: every participant's new rating, his stamps on `match_participants`, and the
 * engine's verdict on `matches` (`elo_factor`, `farm_streak`, `farm_winner_key`, `matchup_key`).
 *
 * <p>The caller has already written the participants' RESULTS and decided the match rates. Throws
 * for a match that is missing or has a shape the engine does not rate; the callers' rollbacks
 * handle that exactly as they handled a throw from the old engine.</p>
 */
export async function rateStoredMatch(db: Db, matchId: string, mode: RatingMode): Promise<RatedMatch> {
    const match = await db.prepare(
        `SELECT created_at, tournament_match_id FROM matches WHERE id = ?`,
    ).bind(matchId).first<{ created_at: string; tournament_match_id: string | null }>();
    if (!match) throw new Error(`rateStoredMatch: no match ${matchId}`);

    const parts = await db.prepare(
        `SELECT user_id, team, result FROM match_participants WHERE match_id = ? ORDER BY user_id ASC`,
    ).bind(matchId).all<ParticipantRow>();
    const sides = sidesOf(parts.results ?? [], mode);
    if (!sides) throw new Error(`rateStoredMatch: match ${matchId} has no ${mode} shape`);

    const atMs = sqliteTimestampToMs(match.created_at) ?? Date.now();
    const ids = sides.flat().map((p) => p.user_id);
    const current = await effectiveRatings(db, ids, mode, atMs);

    const [sideA, sideB] = sides;
    const isTournament = !!match.tournament_match_id;
    const toSide = (rows: ParticipantRow[]): SidePlayer[] => rows.map((p) => {
        const e = current.get(p.user_id)!;
        return { id: p.user_id, rating: e.rating, rd: e.rd, volatility: e.volatility };
    });
    const playersA = toSide(sideA);
    const playersB = toSide(sideB);
    const mKey = matchupOf(mode, playersA, playersB);

    let prev: FarmLink | null = null;
    if (!isTournament) {
        prev = farmLinkOf(await db.prepare(PREV_MATCHUP_SQL)
            .bind(mKey, matchId, match.created_at, match.created_at, matchId)
            .first<ChainRow>());
    }

    // The pure core, shared with the pre-match stake (src/elo/outcome.ts, src/elo/stake.ts).
    const outcome = rateOutcome({
        mode, sideA: playersA, sideB: playersB,
        scoreA: sideA[0]!.result, scoreB: sideB[0]!.result,
        prev, atMs, isTournament,
    });

    const perPlayer = new Map<string, PlayerChange>();
    const writes = [];
    for (const id of ids) {
        const e = current.get(id)!;
        const o = outcome.perPlayer.get(id)!;
        perPlayer.set(id, {
            before: o.before, after: o.after, rdBefore: o.rdBefore, rdAfter: o.rdAfter,
            gamesAfter: e.games_played + 1, winExpected: o.winExpected,
        });
        writes.push(db.prepare(UPSERT_RATING_SQL)
            .bind(id, mode, o.after, o.rdAfter, o.volatilityAfter, match.created_at));
        writes.push(db.prepare(
            `UPDATE match_participants SET rating_before = ?, rating_after = ?, win_expected = ?, rd_before = ?
              WHERE match_id = ? AND user_id = ?`,
        ).bind(o.before, o.after, o.winExpected, o.rdBefore, matchId, id));
    }
    writes.push(db.prepare(
        `UPDATE matches SET elo_factor = ?, farm_streak = ?, farm_winner_key = ?, matchup_key = ?
          WHERE id = ?`,
    ).bind(outcome.factor, outcome.streak, outcome.winnerKey, mKey, matchId));
    await db.batch(writes);

    return { eloFactor: outcome.factor, farmStreak: outcome.streak, matchupKey: mKey, perPlayer };
}

/**
 * What a match between these two sides would do to each player if it were played NOW, both ways
 * (src/elo/stake.ts). Reads only — fresh effective ratings (RD grown to now, volatility included)
 * and the anti-farm chain with the engine's own filter — and takes no ladder lock, like every
 * other reader.
 */
export async function previewOutcomes(
    db: Db,
    mode: RatingMode,
    sideAIds: readonly string[],
    sideBIds: readonly string[],
    isTournament: boolean,
    atMs: number = Date.now(),
): Promise<{ sideA: SidePlayer[]; sideB: SidePlayer[]; prev: FarmLink | null; games: Map<string, number> }> {
    const current = await effectiveRatings(db, [...sideAIds, ...sideBIds], mode, atMs);
    const toSide = (ids: readonly string[]): SidePlayer[] => ids.map((id) => {
        const e = current.get(id)!;
        return { id, rating: e.rating, rd: e.rd, volatility: e.volatility };
    });
    const sideA = toSide(sideAIds);
    const sideB = toSide(sideBIds);
    let prev: FarmLink | null = null;
    if (!isTournament) {
        prev = farmLinkOf(await db.prepare(LATEST_MATCHUP_SQL)
            .bind(matchupOf(mode, sideA, sideB)).first<ChainRow>());
    }
    const games = new Map<string, number>();
    for (const [id, e] of current) games.set(id, e.games_played);
    return { sideA, sideB, prev, games };
}

// ---------------------------------------------------------------- ban refunds

export interface AppliedRefund {
    userId: string;
    mode: string;
    points: number;
    matches: number;
    ratingBefore: number;
    ratingAfter: number;
}

/**
 * The losses a refund covers: every RATED match against the banned player stored up to the
 * refund's own instant, after the previous refund for the same player (so two bans of the same
 * account never pay twice) and from `since` on, where the recipient lost points and was on the
 * OTHER side. Binds: banned, T, since, since, prevT, prevT.
 */
export const REFUND_LOSSES_SQL =
    `SELECT p.user_id AS user_id, COALESCE(m.rating_mode, 'default') AS mode,
            p.rating_before AS rating_before, p.rating_after AS rating_after
       FROM matches m
       JOIN match_participants b ON b.match_id = m.id AND b.user_id = ?
       JOIN match_participants p ON p.match_id = m.id AND p.user_id <> b.user_id
      WHERE m.rated = 1 AND m.created_at <= ?
        AND (? IS NULL OR m.created_at >= ?)
        AND (? IS NULL OR m.created_at > ?)
        AND (COALESCE(m.rating_mode, 'default') = 'default' OR p.team <> b.team)
        AND p.rating_before IS NOT NULL AND p.rating_after IS NOT NULL
        AND p.rating_after < p.rating_before`;

/**
 * Apply one refund event: add each recipient's lost points back to his rating (nothing else
 * moves: not his deviation, not his match count) and record it in `rating_refunds`, keeping
 * `seen_at`. Returns what was given. A revoked or missing refund gives nothing.
 */
export async function applyRefund(db: Db, refundId: string): Promise<AppliedRefund[]> {
    const ref = await db.prepare(
        `SELECT id, banned_user_id, created_at, since FROM ban_refunds
          WHERE id = ? AND revoked_at IS NULL`,
    ).bind(refundId).first<{ id: string; banned_user_id: string; created_at: string; since: string | null }>();
    if (!ref) return [];

    const prev = await db.prepare(
        `SELECT created_at FROM ban_refunds
          WHERE banned_user_id = ? AND revoked_at IS NULL AND id <> ?
            AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).bind(ref.banned_user_id, ref.id, ref.created_at, ref.created_at, ref.id)
        .first<{ created_at: string }>();
    const prevT = prev?.created_at ?? null;

    const rows = await db.prepare(REFUND_LOSSES_SQL).bind(
        ref.banned_user_id, ref.created_at, ref.since, ref.since, prevT, prevT,
    ).all<RefundLossRow>();
    const totals = refundTotals(rows.results ?? []);

    const applied: AppliedRefund[] = [];
    const writes = [];
    for (const t of totals) {
        const cur = await db.prepare(
            `SELECT rating FROM player_ratings WHERE user_id = ? AND mode = ?`,
        ).bind(t.userId, t.mode).first<{ rating: number }>();
        if (!cur) continue;
        const after = cur.rating + t.points;
        applied.push({
            userId: t.userId, mode: t.mode, points: t.points, matches: t.matches,
            ratingBefore: cur.rating, ratingAfter: after,
        });
        writes.push(db.prepare(
            `UPDATE player_ratings SET rating = ?, updated_at = datetime('now')
              WHERE user_id = ? AND mode = ?`,
        ).bind(after, t.userId, t.mode));
        writes.push(db.prepare(
            `INSERT INTO rating_refunds
                 (refund_id, user_id, mode, points, matches, rating_before, rating_after)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (refund_id, user_id, mode) DO UPDATE SET
               points = excluded.points, matches = excluded.matches,
               rating_before = excluded.rating_before, rating_after = excluded.rating_after`,
        ).bind(ref.id, t.userId, t.mode, t.points, t.matches, cur.rating, after));
    }
    if (writes.length) await db.batch(writes);
    return applied;
}
