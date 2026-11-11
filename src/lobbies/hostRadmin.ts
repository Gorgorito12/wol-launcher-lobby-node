/**
 * Which hosts' Radmin addresses the rooms list may hand a signed-in player, so his launcher can
 * ping each host and show a real per-room ping (design 86). Before this the list could only show
 * the viewer's own internet latency, the same on every row.
 *
 * <p>The address is not new information to anybody who could ask: any signed-in player can join
 * a public room and read every member's `radminIp` in `room_state`. So the rule is the same as
 * for joining — public rooms only — and the route that serves it requires a session, unlike the
 * anonymous `/lobbies` memo.</p>
 *
 * <p>Every clause is a refusal, and the refusals are the point:
 * a private room (behind a password: its members chose who sees them), a tournament room (only
 * its entrants may enter), a room no longer alive, a room with no live instance in memory (the
 * address is only ever held there), and a host who has not reported an address in Radmin's
 * 26.0.0.0/8 range.</p>
 */

/** 26.0.0.0/8 — the Radmin VPN range. The same check `LobbyRoom` applies when it is reported. */
const RADMIN_IP_RE = /^26\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** What the list query returns for one lobby. */
export interface HostRadminRow {
    id: string;
    host_user_id: string;
    status: string;
    is_private: number;
    tournament_match_id: string | null;
}

/** The live room, as far as this rule needs to see it. */
export interface HostRadminRoom {
    hostUserId: string;
    members: Record<string, { radminIp?: string } | undefined>;
}

const ALIVE = new Set(['open', 'locked', 'in_game']);

/**
 * The host's Radmin address of every public, live room whose host has reported one, keyed by
 * lobby id. Pure: the caller hands it the rows and a way to find each live room.
 */
export function hostRadminIps(
    rows: readonly HostRadminRow[],
    roomOf: (lobbyId: string) => HostRadminRoom | undefined,
): Record<string, string> {
    const hosts: Record<string, string> = {};
    for (const r of rows) {
        if (!ALIVE.has(r.status)) continue;
        if (r.is_private === 1) continue;
        if (r.tournament_match_id) continue;
        const room = roomOf(r.id);
        if (!room) continue;
        // The ROOM's host, not the row's: the room hands itself on when the host leaves, and
        // the row is written a moment later. Asking the room means never pinging somebody who
        // has just left.
        const ip = room.members[room.hostUserId]?.radminIp;
        if (!ip || !RADMIN_IP_RE.test(ip)) continue;
        hosts[r.id] = ip;
    }
    return hosts;
}

/** The query `GET /lobbies/radmin` runs: only what the rule needs, of the rooms it could keep. */
export const HOST_RADMIN_SQL = `
    SELECT id, host_user_id, status, is_private, tournament_match_id
      FROM lobbies
     WHERE status IN ('open', 'locked', 'in_game')
       AND is_private = 0
       AND tournament_match_id IS NULL
     LIMIT 200`;
