/**
 * Archiving tournaments that nobody has touched in a long time.
 *
 * ---------------------------------------------------------------------------
 * Why this is not a scheduler, and why that is the point
 * ---------------------------------------------------------------------------
 * Staleness is already honoured wherever it MATTERS, by a predicate rather than an event:
 * the public list filters on `aliveWhereClause`, and so do both creation caps. A forgotten
 * tournament therefore stops occupying a place the moment it goes quiet, whether or not
 * anything has marked it.
 *
 * So this sweep is tidiness, not correctness. It exists so that `tournament:list` and the
 * stored `status` agree with what players have been seeing for weeks. That distinction is
 * what lets this server keep having no periodic timer: the only recurring thing in the
 * process is the KV expiry loop, and this feature was not going to be the one that added
 * a second.
 *
 * ---------------------------------------------------------------------------
 * Why it is simpler than the lobby sweep next door
 * ---------------------------------------------------------------------------
 * `sweepOrphanLobbies` needs a snapshot taken at boot and a 90-second grace window,
 * because rooms REVIVE: a launcher reconnects, `getOrCreate` rebuilds the room from its
 * row, and sweeping immediately would close a room with people still sitting in it.
 *
 * A tournament revives nothing, and nothing created by the current process can be seven
 * days old. So there is no race to protect against: one query at startup is exact.
 *
 * ---------------------------------------------------------------------------
 * What archiving is NOT
 * ---------------------------------------------------------------------------
 * `abandoned` crowns nobody, moves no rating, and does not touch a single row in
 * `tournament_matches`. It is not a quiet way of deciding a tournament, which is the thing
 * the maintainer ruled out; it only stops a dead one taking up a slot.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context';
import { finalizeRoom } from '../lobbies/discordAnnounce';
import { staleWhereClause } from './lifecycle';
import { archiveStale, openLobbiesForTournament } from './store';

/**
 * Archive every stale tournament and close the rooms still bound to their matches.
 *
 * Never throws: a sweep that fails must not take the server down with it, and everything
 * it would have done is already true from the readers' point of view.
 */
export async function sweepStaleTournaments(
    ctx: AppContext,
    log: FastifyBaseLogger,
): Promise<number> {
    try {
        // Collect the rooms BEFORE archiving. Afterwards the tournament is terminal and a
        // later reader would have no reason to go looking for its rooms.
        const doomed = await ctx.db.prepare(
            `SELECT t.id FROM tournaments t WHERE ${staleWhereClause('t')}`,
        ).bind().all<{ id: string }>();
        const ids = (doomed.results ?? []).map((r) => r.id);
        if (ids.length === 0) return 0;

        const rooms: string[] = [];
        for (const id of ids) rooms.push(...await openLobbiesForTournament(ctx.db, id));

        const archived = await archiveStale(ctx.db, staleWhereClause('t'));

        for (const lobbyId of rooms) {
            await ctx.db.batch([
                ctx.db.prepare(
                    `UPDATE lobbies SET status='closed', closed_at=datetime('now') WHERE id = ?`,
                ).bind(lobbyId),
                ctx.db.prepare(`DELETE FROM lobby_members WHERE lobby_id = ?`).bind(lobbyId),
            ]);
            ctx.rooms.close(lobbyId);
            finalizeRoom(lobbyId);
        }

        log.info({ tournaments: archived.length, rooms: rooms.length },
            'archived tournaments nobody had touched');
        return archived.length;
    } catch (err) {
        log.info({ err: String(err) }, 'tournament sweep failed');
        return 0;
    }
}
