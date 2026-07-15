import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context';
import { finalizeRoom } from './discordAnnounce';

/**
 * Reap lobbies orphaned by a server restart.
 *
 * A restart wipes all in-memory room state, but the `lobbies` / `lobby_members`
 * rows survive — and nothing ever cleaned them up. The result was a permanent
 * ghost: the room stayed listed as joinable in every launcher's browser and kept
 * its Discord announcement reading "🟢 Open · 1/8" long after it was gone (the
 * reported bug — an embed still showing Open 35 minutes after the room closed
 * and the server restarted).
 */

/**
 * How long to wait after startup before closing lobbies left by the previous
 * process.
 *
 * This CANNOT be zero. A restart kills every socket, but it does NOT kill the
 * room: the launcher's LobbyWebSocket auto-reconnects with backoff up to 30 s,
 * `GET /lobbies/:id/ws` rebuilds the room via `rooms.getOrCreate(...)` from the
 * lobby row, and `hello` re-admits the member against `lobby_members` (which
 * survives the restart). So rooms genuinely REVIVE, and sweeping immediately
 * would close live rooms out from under players still sitting in them.
 * 90 s = the client's 30 s max backoff plus generous margin.
 */
export const ORPHAN_SWEEP_GRACE_MS = 90_000;

/**
 * The lobbies that were already open when this process started — i.e. left by
 * the PREVIOUS one. Snapshot this at startup, before the grace window.
 *
 * Scoping the sweep to a snapshot (rather than re-querying "everything still
 * open" when it fires) is what keeps it from eating a room created by the
 * CURRENT process: a room created at ~T+85 s whose host has its 201 but whose
 * WebSocket hasn't attached yet has zero sockets at T+90 s, and a re-query would
 * close it — a brand-new room, killed seconds after creation. Ids can't collide
 * across processes (they're random short ids), so the snapshot is exact.
 */
export async function snapshotOrphanCandidates(ctx: AppContext): Promise<string[]> {
    try {
        const rows = await ctx.db.prepare(
            `SELECT id FROM lobbies WHERE status IN ('open','locked','in_game')`,
        ).bind().all<{ id: string }>();
        return (rows.results ?? []).map((r) => r.id);
    } catch {
        return [];
    }
}

/**
 * Close each candidate lobby that no socket has reconnected to. Returns how many
 * were closed. Never throws — a failure here must not take the server down.
 *
 * The predicate is "no attached sockets", applied uniformly — INCLUDING
 * 'in_game' rooms. An in-game room WITH sockets is people actually playing: the
 * match is peer-to-peer over Radmin and needs no backend, so closing it would
 * only tear down their lobby window for nothing.
 */
export async function sweepOrphanLobbies(
    ctx: AppContext,
    log: FastifyBaseLogger,
    candidates: string[],
): Promise<number> {
    try {
        let closed = 0;
        for (const id of candidates) {
            const room = ctx.rooms.get(id);
            if (room && room.socketCount > 0) continue; // revived — leave it alone

            // Re-check status: a candidate may have been closed normally during
            // the grace window (its host created a new room, reported a match…),
            // and re-closing would stomp its real closed_at + re-edit the embed.
            const row = await ctx.db.prepare(
                `SELECT status FROM lobbies WHERE id = ?`,
            ).bind(id).first<{ status: string }>();
            if (!row || row.status === 'closed') continue;

            await ctx.db.batch([
                ctx.db.prepare(
                    `UPDATE lobbies SET status='closed', closed_at=datetime('now') WHERE id = ?`,
                ).bind(id),
                ctx.db.prepare(
                    `DELETE FROM lobby_members WHERE lobby_id = ?`,
                ).bind(id),
            ]);
            ctx.rooms.close(id);
            // Rehydrates from lobbies.discord_targets and edits the embed to
            // "Closed" — the whole reason those ids are persisted.
            finalizeRoom(id);
            closed++;
        }

        if (closed > 0) {
            // The players panel derives each user's status from
            // lobbies JOIN lobby_members, so without this nudge everyone
            // connected would keep showing as "in a room".
            ctx.globalChat.refreshPlayers();
            log.info({ closed }, 'Orphan lobby sweep: closed lobbies left by a previous run');
        }
        return closed;
    } catch (err) {
        log.warn({ err }, 'Orphan lobby sweep failed');
        return 0;
    }
}

/**
 * Snapshot the previous process's lobbies NOW, then sweep the survivors once the
 * grace window has passed. Call once at startup.
 */
export function scheduleOrphanLobbySweep(
    ctx: AppContext,
    log: FastifyBaseLogger,
): NodeJS.Timeout {
    // Taken immediately — see snapshotOrphanCandidates for why this must not be
    // re-queried when the timer fires.
    const candidates = snapshotOrphanCandidates(ctx);
    const timer = setTimeout(() => {
        void (async () => {
            await sweepOrphanLobbies(ctx, log, await candidates);
        })();
    }, ORPHAN_SWEEP_GRACE_MS);
    // Don't hold the process open just for the sweep.
    timer.unref?.();
    return timer;
}
