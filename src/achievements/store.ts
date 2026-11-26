/**
 * The achievements' I/O: load a player's history for evaluate.ts, write what it found, read back
 * what he has.
 *
 * <p><b>Writes only ever INSERT OR IGNORE.</b> A medal is never deleted or rewritten by code; the
 * only UPDATEs touch `seen_at` (the launcher showed it) and `revoked_at` (an operator took it
 * back). A revoked row keeps its primary key, which is what stops the next evaluation from
 * handing it straight back.</p>
 */
import type { Db } from '../db';
import type { AppContext } from '../context';
import { sqliteTimestampToMs, toSqliteText } from '../lib/time';
import { catalogFor, modKeyOf, PROMOTION_TIERS, type Ladder } from './catalog';
import { evaluate, type EvalInput, type MatchRow, type DatedEvent, type ModProgress, type LadderPosition } from './evaluate';
import { MEDAL_MIN_DURATION_SECONDS, TOURNAMENT_MIN_PLAYED } from './rules';

export const ACHIEVEMENTS_MIGRATION = '0036_achievements.sql';

export interface EarnedRow {
    mod_key: string;
    achievement_id: string;
    tier: number;
    earned_at: string;
    match_id: string | null;
    tournament_id: string | null;
    seen_at: string | null;
}

export interface Awarded {
    modKey: string;
    id: string;
    tier: number;
    earnedAt: string;
    seen: boolean;
}

/** The roster frozen at Start, or null when the room has none (older rooms). */
function parseRoster(json: string | null): Set<string> | null {
    if (!json) return null;
    try {
        const arr = JSON.parse(json);
        return Array.isArray(arr) ? new Set(arr.filter((v): v is string => typeof v === 'string')) : null;
    } catch {
        return null;
    }
}

const msOf = (ts: string | null | undefined): number => sqliteTimestampToMs(ts ?? null) ?? 0;

/**
 * Everything evaluate.ts needs about one player, in nine indexed queries. `position` is asked only
 * when the caller wants the age and the podium judged now (never for a backfill of old rows).
 */
export async function loadEvalInput(
    db: Db,
    userId: string,
    nowMs: number,
    position?: Partial<Record<Ladder, LadderPosition>>,
): Promise<EvalInput> {
    const own = await db.prepare(
        `SELECT m.id AS match_id, m.created_at, m.lobby_id,
                COALESCE(l.mod_id, m.mod_id) AS mod_id,
                m.map_name, m.duration_seconds, m.rated, m.unrated_reason, m.decided_by,
                COALESCE(m.rating_mode, 'default') AS rating_mode, m.elo_factor,
                l.game_rules, l.roster_at_start,
                p.team, p.civ, p.result, p.rating_before, p.rating_after
           FROM match_participants p
           JOIN matches m ON m.id = p.match_id
           LEFT JOIN lobbies l ON l.id = m.lobby_id
          WHERE p.user_id = ?
          ORDER BY m.created_at ASC, m.id ASC`,
    ).bind(userId).all<{
        match_id: string; created_at: string; lobby_id: string | null; mod_id: string | null;
        map_name: string | null; duration_seconds: number | null; rated: number | null;
        unrated_reason: string | null; decided_by: string | null; rating_mode: string;
        elo_factor: number | null; game_rules: number | null; roster_at_start: string | null;
        team: number | null; civ: string | null; result: number;
        rating_before: number | null; rating_after: number | null;
    }>();

    const others = await db.prepare(
        `SELECT b.match_id, b.user_id, b.team, b.civ, b.result, b.rating_before
           FROM match_participants a
           JOIN match_participants b ON b.match_id = a.match_id AND b.user_id <> a.user_id
          WHERE a.user_id = ?`,
    ).bind(userId).all<{
        match_id: string; user_id: string; team: number | null; civ: string | null;
        result: number; rating_before: number | null;
    }>();
    const othersOf = new Map<string, MatchRow['others']>();
    for (const o of others.results ?? []) {
        const list = othersOf.get(o.match_id) ?? [];
        list.push({ userId: o.user_id, team: o.team, civ: o.civ, result: o.result, ratingBefore: o.rating_before });
        othersOf.set(o.match_id, list);
    }

    const matches: MatchRow[] = (own.results ?? []).map((r) => {
        const roster = parseRoster(r.roster_at_start);
        const list = othersOf.get(r.match_id) ?? [];
        const rosterOk = roster === null || (roster.has(userId) && list.every((o) => roster.has(o.userId)));
        return {
            matchId: r.match_id,
            atMs: msOf(r.created_at),
            modKey: modKeyOf(r.mod_id),
            mapName: r.map_name,
            durationSeconds: r.duration_seconds,
            rated: r.rated,
            unratedReason: r.unrated_reason,
            decidedBy: r.decided_by,
            ratingMode: r.rating_mode === 'team' ? 'team' : 'default',
            eloFactor: r.elo_factor,
            lobbyId: r.lobby_id,
            gameRules: r.game_rules,
            rosterOk,
            team: r.team,
            civ: r.civ,
            result: r.result,
            ratingBefore: r.rating_before,
            ratingAfter: r.rating_after,
            others: list,
        };
    });

    // "Host": rooms he opened that were played to a real length, one per room.
    const hosted = await db.prepare(
        `SELECT l.id AS lobby_id, l.mod_id, MIN(m.created_at) AS played_at
           FROM lobbies l
           JOIN matches m ON m.lobby_id = l.id
          WHERE (l.created_by = ? OR (l.created_by IS NULL AND l.host_user_id = ?))
            AND m.duration_seconds >= ?
            AND (m.rated = 1 OR m.unrated_reason IN
                 ('not_competitive', 'mod_not_ranked', 'not_1v1', 'no_decided_result', 'teams_mismatch'))
          GROUP BY l.id
          ORDER BY played_at ASC`,
    ).bind(userId, userId, MEDAL_MIN_DURATION_SECONDS).all<{ lobby_id: string; mod_id: string | null; played_at: string }>();
    const hostedRooms: DatedEvent[] = (hosted.results ?? []).map((r) => ({
        modKey: modKeyOf(r.mod_id), atMs: msOf(r.played_at), lobbyId: r.lobby_id,
    }));

    const tournamentEvents = async (sql: string): Promise<DatedEvent[]> => {
        const rows = await db.prepare(sql).bind(userId, TOURNAMENT_MIN_PLAYED)
            .all<{ id: string; mod_id: string | null; finished_at: string | null }>();
        return (rows.results ?? []).map((r) => ({
            modKey: modKeyOf(r.mod_id), atMs: msOf(r.finished_at), tournamentId: r.id,
        }));
    };
    const playedGames = `(SELECT COUNT(*) FROM tournament_matches tm
                           WHERE tm.tournament_id = t.id AND tm.outcome = 'played')`;
    const championOf = await tournamentEvents(
        `SELECT t.id, t.mod_id, t.finished_at
           FROM tournament_entrant_members em
           JOIN tournament_entrants e ON e.id = em.entrant_id
           JOIN tournaments t ON t.id = e.tournament_id AND t.winner_entrant_id = e.id
          WHERE em.user_id = ? AND t.status = 'finished' AND ${playedGames} >= ?
          ORDER BY t.finished_at ASC`);
    const organiserOf = await tournamentEvents(
        `SELECT t.id, t.mod_id, t.finished_at FROM tournaments t
          WHERE t.owner_user_id = ? AND t.status = 'finished' AND ${playedGames} >= ?
          ORDER BY t.finished_at ASC`);

    const ratings = await db.prepare(
        `SELECT mode, games_played FROM player_ratings WHERE user_id = ?`,
    ).bind(userId).all<{ mode: string; games_played: number }>();
    const gamesPlayed: Record<Ladder, number> = { default: 0, team: 0 };
    for (const r of ratings.results ?? []) if (r.mode === 'default' || r.mode === 'team') gamesPlayed[r.mode] = r.games_played;

    return { userId, nowMs, matches, hostedRooms, championOf, organiserOf, gamesPlayed, position };
}

/**
 * His place on both ladders right now, for Promotion and On Top. Imported lazily: stats/rest
 * imports half the server and src/users/badgeMode.ts documents the cycle a top-level import makes.
 */
export async function loadPosition(ctx: AppContext, userId: string): Promise<Partial<Record<Ladder, LadderPosition>>> {
    const { ladderRanks, ladderSize } = await import('../stats/rest');
    const out: Partial<Record<Ladder, LadderPosition>> = {};
    for (const mode of ['default', 'team'] as const) {
        try {
            const ranks = await ladderRanks(ctx, [userId], mode);
            const rank = ranks.get(userId);
            if (rank === undefined) continue;
            out[mode] = { rank, size: await ladderSize(ctx, mode) };
        } catch { /* no place known: no position medal this time */ }
    }
    return out;
}

/** When the achievements migration was applied: medals for matches before it are born seen. */
let epochMs: number | null | undefined;
export async function achievementsEpochMs(db: Db): Promise<number> {
    if (epochMs === undefined) {
        try {
            const row = await db.prepare(`SELECT applied_at FROM _migrations WHERE filename = ?`)
                .bind(ACHIEVEMENTS_MIGRATION).first<{ applied_at: string }>();
            epochMs = sqliteTimestampToMs(row?.applied_at ?? null);
        } catch {
            epochMs = null;
        }
    }
    return epochMs ?? 0;
}

/** For tests: forget the cached epoch. */
export function resetAchievementsEpochForTests(): void {
    epochMs = undefined;
}

/**
 * Write every satisfied medal that is not already there. Returns only the rows this call
 * inserted. `bornSeen` writes them as already shown (the backfill); otherwise a medal earned
 * before the migration epoch is born seen too, so the deploy does not celebrate history.
 */
export async function awardNew(
    db: Db,
    userId: string,
    progress: Map<string, ModProgress>,
    opts: { bornSeen?: boolean; epochMs?: number } = {},
): Promise<Awarded[]> {
    const awarded: Awarded[] = [];
    const insert = db.prepare(
        `INSERT OR IGNORE INTO player_achievements
             (user_id, mod_key, achievement_id, tier, earned_at, match_id, tournament_id, seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const epoch = opts.epochMs ?? 0;
    for (const [modKey, items] of progress) {
        if (!modKey) continue;
        for (const item of items.values()) {
            for (const e of item.earned) {
                const earnedAt = toSqliteText(e.atMs || Date.now());
                const seen = !!opts.bornSeen || (epoch > 0 && e.atMs < epoch);
                const res = await insert.bind(
                    userId, modKey, item.def.id, e.tier, earnedAt,
                    e.matchId ?? null, e.tournamentId ?? null, seen ? earnedAt : null,
                ).run();
                if (res.changes === 1) awarded.push({ modKey, id: item.def.id, tier: e.tier, earnedAt, seen });
            }
        }
    }
    return awarded;
}

/** Evaluate one player and write what is new. Never throws to its caller's caller: see hooks.ts. */
export async function evaluateAndAward(
    ctx: AppContext,
    userId: string,
    opts: { bornSeen?: boolean; withPosition?: boolean; nowMs?: number } = {},
): Promise<{ awarded: Awarded[]; progress: Map<string, ModProgress> }> {
    const nowMs = opts.nowMs ?? Date.now();
    const position = opts.withPosition === false ? undefined : await loadPosition(ctx, userId);
    const input = await loadEvalInput(ctx.db, userId, nowMs, position);
    const progress = evaluate(input);
    const awarded = await awardNew(ctx.db, userId, progress, {
        bornSeen: opts.bornSeen, epochMs: await achievementsEpochMs(ctx.db),
    });
    return { awarded, progress };
}

/** What he has, every game, revoked ones left out. */
export async function listEarned(db: Db, userId: string): Promise<EarnedRow[]> {
    const rows = await db.prepare(
        `SELECT mod_key, achievement_id, tier, earned_at, match_id, tournament_id, seen_at
           FROM player_achievements
          WHERE user_id = ? AND revoked_at IS NULL
          ORDER BY earned_at ASC, achievement_id ASC, tier ASC`,
    ).bind(userId).all<EarnedRow>();
    return rows.results ?? [];
}

/** How many medals he holds in each game, counting only medals the catalogue still has. */
export async function countEarned(db: Db, userId: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const r of await listEarned(db, userId)) {
        if (!catalogFor(r.mod_key).some((g) => g.items.some((i) => i.id === r.achievement_id))) continue;
        out.set(r.mod_key, (out.get(r.mod_key) ?? 0) + 1);
    }
    return out;
}

/** Mark some (or, with none named, all) of his unseen medals as shown. Only ever his own rows. */
export async function markSeen(
    db: Db,
    userId: string,
    items?: ReadonlyArray<{ mod: string; id: string; tier: number }>,
): Promise<number> {
    if (!items || items.length === 0) {
        const r = await db.prepare(
            `UPDATE player_achievements SET seen_at = datetime('now')
              WHERE user_id = ? AND seen_at IS NULL`,
        ).bind(userId).run();
        return r.changes;
    }
    let n = 0;
    const stmt = db.prepare(
        `UPDATE player_achievements SET seen_at = datetime('now')
          WHERE user_id = ? AND mod_key = ? AND achievement_id = ? AND tier = ? AND seen_at IS NULL`,
    );
    for (const i of items.slice(0, 50)) n += (await stmt.bind(userId, modKeyOf(i.mod), i.id, i.tier).run()).changes;
    return n;
}

/** Operator: take a medal back. Keeps the row so it is not awarded again. */
export async function revoke(db: Db, userId: string, modKey: string, id: string, tier: number): Promise<number> {
    const r = await db.prepare(
        `UPDATE player_achievements SET revoked_at = datetime('now')
          WHERE user_id = ? AND mod_key = ? AND achievement_id = ? AND tier = ? AND revoked_at IS NULL`,
    ).bind(userId, modKeyOf(modKey), id, tier).run();
    return r.changes;
}

export { PROMOTION_TIERS };
