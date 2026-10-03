/**
 * Rebuild the whole ladder by replaying every rated match, and every ban refund, in order.
 *
 * <p>Every correction, operator or automatic, edits the stored rows and calls this: "undo this
 * match" cannot be computed (a rating update has no inverse), but "recompute the ladder as though
 * this match had always read the way it now reads" can, and it is exactly as correct. It also
 * repairs a corruption nothing else detects — a path that threw after rating but before its own
 * bookkeeping leaves players with points the stored rows do not justify, and a replay simply
 * cannot express that state.</p>
 *
 * <p><b>Order is `created_at`, then `id`</b>: ratings were applied when each match was REPORTED.
 * Refunds sit on the same timeline at their own `created_at`; at an equal instant the match goes
 * first. The engine's inputs are all stored rows (src/elo/ladder.ts, rateStoredMatch), so the same
 * history always rebuilds the same ladder, decay, anti-farm and refunds included.</p>
 *
 * <p><b>There are no seasons any more, so a replay always rebuilds everything.</b> The old
 * `fromSeason` option is accepted and ignored, so a caller written for it still compiles.</p>
 *
 * <p>It runs in ONE transaction (`Db.transaction`), so another process — the server, while an
 * operator applies a correction from the CLI — never reads a half-built ladder.</p>
 *
 * <p><b>Inside the server it runs under {@link withLadderLock}.</b></p>
 */
import { applyRefund, rateStoredMatch } from './ladder';
import type { Db } from '../db';

let ladderChain: Promise<unknown> = Promise.resolve();

/**
 * Serialise everything that writes ratings.
 *
 * <p><b>EVERY call to `rateStoredMatch` and `recomputeLadder` on the server goes through this, and
 * a new one that does not is a bug.</b> A replay deletes every rating and rebuilds them one match
 * at a time; a report rated inside that window would read a half-built ladder and then be
 * overwritten. Nobody would ever see it happen.</p>
 *
 * <p>A chain rather than a flag because a chain cannot be forgotten open. In-process, which here
 * is the whole process — this server is one Node. Callers must not nest it.</p>
 */
export function withLadderLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = ladderChain.then(fn, fn);
    ladderChain = run.catch(() => undefined);
    return run;
}

export interface ReplayOptions {
    /** Ignored: there are no seasons. Kept so older callers compile. */
    fromSeason?: number;
}

export interface ReplayResult {
    matches: number;
    players: number;
    refunds: number;
    /** Always 1; kept for the shape older callers print. */
    fromSeason: number;
}

interface TimelineMatch { kind: 'match'; id: string; created_at: string; mode: 'default' | 'team' }
interface TimelineRefund { kind: 'refund'; id: string; created_at: string }

export async function recomputeLadder(db: Db, _opts: ReplayOptions = {}): Promise<ReplayResult> {
    return db.transaction(async () => {
        // rating_mode NULL is a row written before migration 0010, all of which were 1v1. Fetched
        // BEFORE the stamps are cleared: the `rated IS NULL` branch recognises pre-0006 rows by
        // them (0024 set rated = 1 on all of those; the branch stays for an old restore).
        const rated = await db.prepare(
            `SELECT id, created_at, COALESCE(rating_mode, 'default') AS rating_mode FROM matches
              WHERE rated = 1
                 OR (rated IS NULL AND EXISTS (
                        SELECT 1 FROM match_participants p
                         WHERE p.match_id = matches.id AND p.rating_after IS NOT NULL))
              ORDER BY created_at ASC, id ASC`,
        ).bind().all<{ id: string; created_at: string; rating_mode: string }>();

        const refunds = await db.prepare(
            `SELECT id, created_at FROM ban_refunds WHERE revoked_at IS NULL
              ORDER BY created_at ASC, id ASC`,
        ).bind().all<{ id: string; created_at: string }>();

        const timeline: Array<TimelineMatch | TimelineRefund> = [
            ...(rated.results ?? []).map((m): TimelineMatch => ({
                kind: 'match', id: m.id, created_at: m.created_at,
                mode: m.rating_mode === 'team' ? 'team' : 'default',
            })),
            ...(refunds.results ?? []).map((r): TimelineRefund => ({
                kind: 'refund', id: r.id, created_at: r.created_at,
            })),
        ];
        timeline.sort((a, b) => {
            if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
            if (a.kind !== b.kind) return a.kind === 'match' ? -1 : 1;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });

        await db.prepare(`DELETE FROM player_ratings`).bind().run();
        await db.prepare(
            `UPDATE match_participants SET rating_before = NULL, rating_after = NULL`,
        ).bind().run();
        // Clearing elo_factor is what makes the anti-farm lookup see ONLY matches already
        // replayed: it asks for `elo_factor IS NOT NULL`.
        await db.prepare(
            `UPDATE matches SET elo_factor = NULL, farm_streak = NULL, farm_winner_key = NULL`,
        ).bind().run();

        const touched = new Set<string>();
        const refundRows = new Set<string>();
        let matches = 0;
        for (const item of timeline) {
            if (item.kind === 'match') {
                try {
                    const r = await rateStoredMatch(db, item.id, item.mode);
                    for (const id of r.perPlayer.keys()) touched.add(id);
                    matches += 1;
                } catch {
                    // A stored row the engine cannot rate (a shape that should never have been
                    // marked rated). Skipping it is what the old replay did with < 2 players.
                }
            } else {
                for (const a of await applyRefund(db, item.id)) {
                    refundRows.add(`${item.id}\u0000${a.userId}\u0000${a.mode}`);
                }
            }
        }

        // A refund row this run did not produce no longer describes anything: its refund was
        // revoked, or the losses it paid for were voided.
        const existing = await db.prepare(
            `SELECT refund_id, user_id, mode FROM rating_refunds`,
        ).bind().all<{ refund_id: string; user_id: string; mode: string }>();
        const stale = (existing.results ?? [])
            .filter((r) => !refundRows.has(`${r.refund_id}\u0000${r.user_id}\u0000${r.mode}`));
        if (stale.length) {
            await db.batch(stale.map((r) => db.prepare(
                `DELETE FROM rating_refunds WHERE refund_id = ? AND user_id = ? AND mode = ?`,
            ).bind(r.refund_id, r.user_id, r.mode)));
        }

        return { matches, players: touched.size, refunds: refundRows.size, fromSeason: 1 };
    });
}
