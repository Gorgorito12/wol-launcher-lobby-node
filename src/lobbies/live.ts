/**
 * GET /lobbies/:id/live — a room as somebody OUTSIDE it may see it (the launcher's "See match"
 * window, design 99). A read model, never a join: none of the four doors that keep a stranger out
 * of a room (in-game joins, bracket-only rooms, zero spectator seats, the member-only socket)
 * opens for it.
 *
 * <p>What it carries: the room's facts, who is in it (from the DATABASE, so it survives a
 * restart) with their ratings through the same redactor every public payload uses, and, once the
 * match is stored, the result — winner side, each player's civilization, duration. What it never
 * carries: chat, a password hash, a Radmin address, an in-game name. A closed room answers from
 * its stored match for 24 hours, then 404.</p>
 *
 * <p><b>A private tournament's room answers exactly like a missing id</b> to anybody who may not
 * see the tournament. The gate runs BEFORE the memo, and the memo holds only what every permitted
 * viewer sees alike.</p>
 */
import type { Db } from '../db';
import { publicRatingsFor } from '../elo/placementPrivacy';
import { getTournament, maySee } from '../tournaments/store';

/** How long a closed room can still be watched (its result). */
export const CLOSED_VISIBLE_MS = 24 * 60 * 60 * 1000;

/** How long one answer is reused for everybody asking about the same room. */
export const LIVE_MEMO_MS = 3000;

export type LivePhase = 'waiting' | 'playing' | 'ended';

export interface LiveMember {
    id: string;
    display_name: string;
    discord_username: string;
    avatar_url: string | null;
    role: 'player' | 'spectator';
    team: 1 | 2 | null;
    ready: boolean;
    rating?: number;
    games_played: number;
    rating_team?: number;
    games_played_team: number;
}

export interface LiveResultPlayer {
    id: string;
    display_name: string;
    avatar_url: string | null;
    team: number;
    civ: string | null;
    result: number;
}

export interface LiveResult {
    match_id: string;
    ended_at: string;
    duration_seconds: number;
    rated: boolean | null;
    decided_by: string | null;
    players: LiveResultPlayer[];
}

export interface LiveBody {
    id: string;
    title: string;
    mod_id: string;
    competitive: boolean;
    max_players: number;
    spectator_slots: number;
    game_rules: number;
    status: string;
    phase: LivePhase;
    started_at: string | null;
    tournament_id: string | null;
    tournament_match_id: string | null;
    members: LiveMember[];
    result: LiveResult | null;
}

export interface LiveLobbyRow {
    id: string;
    title: string;
    mod_id: string;
    competitive: number;
    max_players: number;
    spectator_slots: number;
    game_rules: number | null;
    status: string;
    started_at: string | null;
    closed_at: string | null;
    tournament_match_id: string | null;
    tournament_id: string | null;
}

/** The lobby row with the tournament it belongs to, or undefined. */
export async function loadLiveLobby(db: Db, lobbyId: string): Promise<LiveLobbyRow | undefined> {
    return db.prepare(
        `SELECT l.id, l.title, l.mod_id, l.competitive, l.max_players, l.spectator_slots, l.game_rules,
                l.status, l.started_at, l.closed_at, l.tournament_match_id,
                (SELECT tm.tournament_id FROM tournament_matches tm WHERE tm.id = l.tournament_match_id) AS tournament_id
           FROM lobbies l WHERE l.id = ?`,
    ).bind(lobbyId).first<LiveLobbyRow>();
}

/** SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) or ISO, as milliseconds; NaN when unreadable. */
function utcMs(text: string | null): number {
    if (!text) return NaN;
    const iso = text.includes('T') ? text : text.replace(' ', 'T') + 'Z';
    return Date.parse(iso);
}

/** Whether a closed room is still within its 24 hours. A room never closed always is. */
export function stillVisible(row: Pick<LiveLobbyRow, 'status' | 'closed_at'>, nowMs: number): boolean {
    if (row.status !== 'closed') return true;
    const closed = utcMs(row.closed_at);
    return Number.isFinite(closed) && nowMs - closed <= CLOSED_VISIBLE_MS;
}

/**
 * Whether this caller may watch this room: it exists, a closed one is within its 24 hours, and a
 * private tournament's room only for whoever may see that tournament (owner, co-organiser,
 * entrant, or the code). Every refusal is the same answer as a missing id.
 */
export async function mayWatch(
    db: Db, row: LiveLobbyRow | undefined, userId: string | undefined, code: string | undefined, nowMs: number,
): Promise<{ ok: boolean; private: boolean }> {
    if (!row || !stillVisible(row, nowMs)) return { ok: false, private: false };
    if (!row.tournament_id) return { ok: true, private: false };
    const t = await getTournament(db, row.tournament_id);
    if (!t) return { ok: true, private: false };
    const allowed = await maySee(db, t, userId, code);
    return { ok: allowed, private: t.visibility === 'private' };
}

/** The body for a room the caller may see. */
export async function buildLive(db: Db, row: LiveLobbyRow): Promise<LiveBody> {
    const members = row.status === 'closed' ? [] : (await db.prepare(
        `SELECT lm.user_id, lm.is_ready, lm.role, lm.team,
                u.discord_username, u.display_name, u.avatar_url,
                (SELECT rating FROM player_ratings WHERE user_id = lm.user_id AND mode = 'default') AS rating,
                (SELECT games_played FROM player_ratings WHERE user_id = lm.user_id AND mode = 'default') AS games_played,
                (SELECT rating FROM player_ratings WHERE user_id = lm.user_id AND mode = 'team') AS rating_team,
                (SELECT games_played FROM player_ratings WHERE user_id = lm.user_id AND mode = 'team') AS games_played_team
           FROM lobby_members lm JOIN users u ON u.id = lm.user_id
          WHERE lm.lobby_id = ?
          ORDER BY lm.joined_at ASC`,
    ).bind(row.id).all<{
        user_id: string; is_ready: number; role: 'player' | 'spectator'; team: number | null;
        discord_username: string; display_name: string; avatar_url: string | null;
        rating: number | null; games_played: number | null; rating_team: number | null; games_played_team: number | null;
    }>()).results ?? [];

    // Through the one redactor every public payload uses: a player being placed, or one who
    // keeps his rating private, has no number here.
    const shown: LiveMember[] = members.map((m) => publicRatingsFor(m.user_id, {
        id: m.user_id,
        display_name: m.display_name,
        discord_username: m.discord_username,
        avatar_url: m.avatar_url,
        role: m.role,
        team: m.team === 1 || m.team === 2 ? m.team : null,
        ready: m.is_ready === 1,
        ...(m.rating != null ? { rating: Math.round(m.rating) } : {}),
        games_played: m.games_played ?? 0,
        ...(m.rating_team != null ? { rating_team: Math.round(m.rating_team) } : {}),
        games_played_team: m.games_played_team ?? 0,
    }));

    const match = await db.prepare(
        `SELECT id, ended_at, duration_seconds, rated, decided_by
           FROM matches WHERE lobby_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).bind(row.id).first<{ id: string; ended_at: string; duration_seconds: number; rated: number | null; decided_by: string | null }>();

    let result: LiveResult | null = null;
    if (match) {
        const players = (await db.prepare(
            `SELECT p.user_id, p.team, p.civ, p.result, u.display_name, u.avatar_url
               FROM match_participants p JOIN users u ON u.id = p.user_id
              WHERE p.match_id = ? ORDER BY p.team, u.display_name`,
        ).bind(match.id).all<{
            user_id: string; team: number; civ: string | null; result: number; display_name: string; avatar_url: string | null;
        }>()).results ?? [];
        result = {
            match_id: match.id,
            ended_at: match.ended_at,
            duration_seconds: match.duration_seconds,
            rated: match.rated == null ? null : match.rated === 1,
            decided_by: match.decided_by,
            // No rating before/after: a result is about who won, and the numbers have their own
            // privacy rules.
            players: players.map((p) => ({
                id: p.user_id, display_name: p.display_name, avatar_url: p.avatar_url,
                team: p.team, civ: p.civ, result: p.result,
            })),
        };
    }

    const phase: LivePhase = match || row.status === 'closed' ? 'ended'
        : row.status === 'in_game' ? 'playing'
        : 'waiting';

    return {
        id: row.id,
        title: row.title,
        mod_id: row.mod_id,
        competitive: row.competitive === 1,
        max_players: row.max_players,
        spectator_slots: row.spectator_slots ?? 0,
        game_rules: row.game_rules ?? 0,
        status: row.status,
        phase,
        started_at: row.status === 'in_game' || match ? row.started_at : null,
        tournament_id: row.tournament_id,
        tournament_match_id: row.tournament_match_id,
        members: shown,
        result,
    };
}

/** One answer per room for {@link LIVE_MEMO_MS}; dropped whenever rooms or matches change. */
const memo = new Map<string, { at: number; body: LiveBody }>();
const MEMO_MAX = 64;

export function memoGet(lobbyId: string, nowMs: number): LiveBody | undefined {
    const hit = memo.get(lobbyId);
    if (!hit) return undefined;
    if (nowMs - hit.at > LIVE_MEMO_MS) {
        memo.delete(lobbyId);
        return undefined;
    }
    return hit.body;
}

export function memoPut(lobbyId: string, body: LiveBody, nowMs: number): void {
    if (memo.size >= MEMO_MAX) {
        const first = memo.keys().next().value;
        if (first !== undefined) memo.delete(first);
    }
    memo.set(lobbyId, { at: nowMs, body });
}

export function clearLiveMemo(): void {
    memo.clear();
}
