/**
 * Teams chosen in the room, for 2v2 and 3v3: who may put whom on which side, when a competitive
 * room may start, and the odds the room shows.
 *
 * <p><b>Why teams moved into the room.</b> Sides used to exist only inside Age of Empires III and
 * were read back from the recording afterwards, so nothing could tell players before the match
 * who was meant to be with whom, and a competitive 2v2 could start lopsided. Now each player picks
 * Team 1 or Team 2 (the host may move anybody), a competitive room cannot start until the teams are
 * complete and even, and a recording whose sides differ from the room's is stored unrated
 * (`teams_mismatch`, src/matches/teamsMismatch.ts).</p>
 *
 * <p><b>Older launchers.</b> A launcher that does not announce the `room_teams` feature cannot
 * pick a team, so the team checks only apply when EVERY player in the room announced it; the
 * missing-players check applies whenever the HOST announced it, since the host is the one who
 * reads the refusal. Without either, the room behaves exactly as before.</p>
 *
 * <p>Pure; LobbyRoom does the I/O and the broadcasts.</p>
 */
import { winProbability } from '../elo/glicko2';

export type TeamNo = 1 | 2;

/** Seats per team for a room's PLAYING seats; 0 means the room has no teams (a 1v1, or anything odd). */
export function teamCapacity(playingSeats: number): number {
    return playingSeats === 4 ? 2 : playingSeats === 6 ? 3 : 0;
}

export function parseTeam(raw: unknown): TeamNo | null | undefined {
    if (raw === null) return null;
    if (raw === 1 || raw === '1') return 1;
    if (raw === 2 || raw === '2') return 2;
    return undefined;
}

export interface TeamMember {
    team?: TeamNo | null;
    role?: string;
}

export type TeamChangeError =
    | 'team_not_supported'
    | 'game_in_progress'
    | 'forbidden'
    | 'not_in_room'
    | 'spectator_no_team'
    | 'bad_team'
    | 'team_full';

export interface TeamChange {
    actorId: string;
    hostId: string;
    targetId: string;
    /** 1, 2, or null to leave the teams. `undefined` is a malformed value. */
    team: TeamNo | null | undefined;
    playingSeats: number;
    members: Readonly<Record<string, TeamMember>>;
    inGame: boolean;
}

/** Why a team change is refused, or null when it may go through. Checked in this order. */
export function validateTeamChange(c: TeamChange): TeamChangeError | null {
    const capacity = teamCapacity(c.playingSeats);
    if (capacity === 0) return 'team_not_supported';
    if (c.inGame) return 'game_in_progress';
    if (c.actorId !== c.targetId && c.actorId !== c.hostId) return 'forbidden';
    const target = c.members[c.targetId];
    if (!target) return 'not_in_room';
    if (target.role === 'spectator') return 'spectator_no_team';
    if (c.team === undefined) return 'bad_team';
    if (c.team === null) return null;
    const taken = Object.entries(c.members)
        .filter(([id, m]) => id !== c.targetId && m.role !== 'spectator' && m.team === c.team)
        .length;
    return taken >= capacity ? 'team_full' : null;
}

export type StartRefusal =
    | { code: 'start_missing_players'; have: number; need: number }
    | { code: 'start_player_without_team'; user_ids: string[] }
    | { code: 'start_uneven_teams'; team1: number; team2: number };

export interface StartCheck {
    competitive: boolean;
    playingSeats: number;
    players: readonly { id: string; team?: TeamNo | null }[];
    /** The host announced `room_teams`: he can read a refusal. */
    hostUnderstands: boolean;
    /** Every player announced `room_teams`: they can all pick a side. */
    teamsEnforced: boolean;
}

/**
 * Why a competitive room may not start yet, or null. In THIS order, and the launcher shows the
 * same one: a room that is not full cannot be judged on its teams; a player with no team cannot be
 * counted on either side.
 */
export function startRefusal(c: StartCheck): StartRefusal | null {
    if (!c.competitive || !c.hostUnderstands) return null;
    if (c.players.length < c.playingSeats) {
        return { code: 'start_missing_players', have: c.players.length, need: c.playingSeats };
    }
    if (teamCapacity(c.playingSeats) === 0 || !c.teamsEnforced) return null;
    const without = c.players.filter((p) => p.team !== 1 && p.team !== 2).map((p) => p.id);
    if (without.length > 0) return { code: 'start_player_without_team', user_ids: without };
    const t1 = c.players.filter((p) => p.team === 1).length;
    const t2 = c.players.filter((p) => p.team === 2).length;
    if (t1 !== t2) return { code: 'start_uneven_teams', team1: t1, team2: t2 };
    return null;
}

export interface OddsPlayer {
    id: string;
    team?: TeamNo | null;
    rating?: number;
    rd?: number;
    ratingTeam?: number;
    rdTeam?: number;
}

export interface RoomOdds {
    mode: 'default' | 'team';
    /** Team rooms: the chance of each team, whole percent; null while a team is empty. */
    teams: { '1': number; '2': number } | null;
    /** 1v1 rooms: each player's chance; null until both seats are taken. */
    players: Record<string, number> | null;
}

/**
 * The win probability a room shows, from Glicko (src/elo/glicko2.ts, winProbability). A player
 * whose rating is unknown is left out rather than counted as 1500: the odds would be invented.
 */
export function roomOdds(playingSeats: number, players: readonly OddsPlayer[]): RoomOdds {
    if (teamCapacity(playingSeats) > 0) {
        const side = (t: TeamNo) => players
            .filter((p) => p.team === t && p.ratingTeam !== undefined && p.rdTeam !== undefined)
            .map((p) => ({ rating: p.ratingTeam!, rd: p.rdTeam! }));
        const p = winProbability(side(1), side(2));
        return { mode: 'team', teams: p ? { '1': p.a, '2': p.b } : null, players: null };
    }
    const rated = players.filter((p) => p.rating !== undefined && p.rd !== undefined);
    if (playingSeats !== 2 || rated.length !== 2 || players.length !== 2) {
        return { mode: 'default', teams: null, players: null };
    }
    const [a, b] = rated as [OddsPlayer, OddsPlayer];
    const p = winProbability([{ rating: a.rating!, rd: a.rd! }], [{ rating: b.rating!, rd: b.rd! }]);
    return { mode: 'default', teams: null, players: p ? { [a.id]: p.a, [b.id]: p.b } : null };
}

/** The teams to freeze at Start, or null when the room did not use room teams. */
export function teamsAtStart(
    playingSeats: number,
    teamsEnforced: boolean,
    players: readonly { id: string; team?: TeamNo | null }[],
): Record<string, TeamNo> | null {
    if (teamCapacity(playingSeats) === 0 || !teamsEnforced) return null;
    const out: Record<string, TeamNo> = {};
    for (const p of players) {
        if (p.team !== 1 && p.team !== 2) return null;
        out[p.id] = p.team;
    }
    return out;
}
