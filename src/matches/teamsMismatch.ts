/**
 * Whether the sides a team game was PLAYED with differ from the teams chosen in the room.
 *
 * <p>Only the PARTITION matters, never the numbers: "Team 1" in the room and team 1 in the game are
 * labels picked independently, so Ana and Luis together against Pedro and Sara is the same match
 * whatever number each side wore. What counts is who was with whom.</p>
 *
 * <p>Answers false (no mismatch) whenever the comparison cannot be made: no room teams frozen at
 * Start (a 1v1, an older launcher in the room), or a recording that does not name a side for every
 * player the room had. A match is never refused on a comparison that could not be done.</p>
 *
 * <p>Pure.</p>
 */

export function parseRoomTeams(json: string | null | undefined): Record<string, number> | null {
    if (!json) return null;
    try {
        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const out: Record<string, number> = {};
        for (const [id, t] of Object.entries(parsed as Record<string, unknown>)) {
            if (t === 1 || t === 2) out[id] = t;
        }
        return Object.keys(out).length > 0 ? out : null;
    } catch {
        return null;
    }
}

function partitionKey(groups: Map<number, string[]>): string {
    return [...groups.values()].map((ids) => [...ids].sort().join(',')).sort().join('|');
}

function groupBy(entries: Iterable<[string, number]>): Map<number, string[]> {
    const out = new Map<number, string[]>();
    for (const [id, t] of entries) {
        const list = out.get(t) ?? [];
        list.push(id);
        out.set(t, list);
    }
    return out;
}

export function teamsMismatch(
    participants: readonly { user_id: string; team: number }[],
    roomTeams: Readonly<Record<string, number>> | null,
): boolean {
    if (!roomTeams) return false;
    const roomIds = Object.keys(roomTeams);
    const played = new Map(participants.map((p) => [p.user_id, p.team | 0] as [string, number]));
    if (!roomIds.every((id) => played.has(id))) return false;
    if (participants.length !== roomIds.length) return true;
    return partitionKey(groupBy(played.entries()))
        !== partitionKey(groupBy(Object.entries(roomTeams) as [string, number][]));
}

/** The in-game sides as lists of user ids, in team-number order, for the History. */
export function sidesFromParticipants(
    participants: readonly { user_id: string; team: number }[],
): string[][] {
    const groups = groupBy(participants.map((p) => [p.user_id, p.team | 0] as [string, number]));
    return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, ids]) => ids.sort());
}

/** The room's sides as lists of user ids, Team 1 first. */
export function sidesFromRoomTeams(roomTeams: Readonly<Record<string, number>> | null): string[][] | null {
    if (!roomTeams) return null;
    const groups = groupBy(Object.entries(roomTeams) as [string, number][]);
    return [1, 2].map((t) => (groups.get(t) ?? []).sort());
}
