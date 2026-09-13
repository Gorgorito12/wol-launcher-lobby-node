/**
 * Rebuild the whole ladder by replaying every rated match in order.
 *
 * <p>This was `scripts/admin.ts`'s centre of gravity, and it moved here the day the SERVER
 * needed it too: a match founded by inference (`decided_by = 'founded'`) can be contradicted
 * by a later reading, and undoing it means undoing its rating. <c>applyMatch</c> has no
 * inverse and nothing snapshots a player's prior state, so "undo this match" cannot be
 * computed — but "recompute the ladder as though this match had always read the way it now
 * reads" can, and it is exactly as correct. Every correction, operator or automatic, edits
 * the row and calls this.</p>
 *
 * <p>It also repairs a corruption nothing else detects. If anything throws after
 * <c>applyMatch</c> inside <c>maybeUpgradeFromConfirmation</c>, that path rolls back the
 * match and participant rows but NOT <c>elo_ratings</c> — the players keep the points and the
 * match becomes eligible to be rated a second time. A replay simply cannot express that
 * state.</p>
 *
 * <p><b>Order is <c>created_at</c>, not <c>started_at</c></b>: ratings were applied when each
 * match was REPORTED, and reports do not always arrive in the order the games were played.
 * Replaying by report order is the faithful reproduction.</p>
 *
 * <p>Ratings rows are reset in place rather than deleted, so a player who signed up and never
 * played keeps the 1500/350 row the signup created. Deleting would silently change who has a
 * row at all.</p>
 *
 * <p><b>Inside the server it runs under {@link withLadderLock}.</b> A replay resets every
 * rating and rebuilds them one match at a time; a report rating a match halfway through that
 * would be applied to a half-built ladder and then overwritten. The lock is in-process, which
 * is the whole process — this server is one Node.</p>
 */
import { applyMatch, DEFAULT_RATING, DEFAULT_RD, DEFAULT_VOLATILITY,
         type ParticipantOutcome } from './glicko2';
import type { Db } from '../db';

interface ParticipantRow {
    match_id: string;
    user_id: string;
    team: number;
    result: number;
}

let ladderChain: Promise<unknown> = Promise.resolve();

/**
 * Serialise everything that writes ratings.
 *
 * <p><b>EVERY call to `applyMatch` and `recomputeLadder` on the server goes through this, and
 * a new one that does not is a bug.</b> It shipped applied to one of six call sites, which is
 * worth writing down because the hole it left is invisible: `recomputeLadder` sets every
 * rating back to 1500 and then rebuilds them one match at a time, so a report landing inside
 * that window reads a half-built ladder, computes a delta from 1500, writes it — and the
 * replay, working from a list it fetched before that match existed, overwrites the result. The
 * match keeps its `rating_before`/`rating_after` stamps and moved nothing. Nobody would ever
 * see it happen.</p>
 *
 * <p>Cheap when nothing else is running. It is a chain rather than a flag because a chain
 * cannot be forgotten open: the `.catch` below keeps one failure from wedging every later
 * write, and the lock is released by the promise settling rather than by anyone remembering
 * to release it.</p>
 *
 * <p>In-process, which here is the whole process — this server is one Node. Callers must not
 * nest it; today's do not, because every pairing is sequential (`foundMatchFromReadings`
 * releases before `maybeVoidByCrashLater` takes it).</p>
 */
export function withLadderLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = ladderChain.then(fn, fn);
    ladderChain = run.catch(() => undefined);
    return run;
}

export async function recomputeLadder(db: Db): Promise<{ matches: number; players: number }> {
    // rating_mode travels with each match so the replay can feed it to the ladder it
    // actually belongs to. NULL means a row written before migration 0010, all of which
    // were 1v1 — so it reads as 'default' rather than as unknown.
    const rated = await db.prepare(
        `SELECT id, COALESCE(rating_mode, 'default') AS rating_mode FROM matches
          WHERE rated = 1
             OR (rated IS NULL AND EXISTS (
                    SELECT 1 FROM match_participants p
                     WHERE p.match_id = matches.id AND p.rating_after IS NOT NULL))
          ORDER BY created_at ASC, id ASC`,
    ).bind().all<{ id: string; rating_mode: string }>();

    const ids = (rated.results ?? []).map((r) => ({ id: r.id, mode: r.rating_mode }));

    // No WHERE mode: BOTH ladders are being replayed below, so both are reset here. This
    // is correct only because the loop feeds every match back into its own mode — if this
    // function is ever narrowed to one ladder, this statement has to be narrowed with it,
    // or recomputing 1v1 would flatten the team ratings on its way past.
    await db.prepare(
        `UPDATE elo_ratings
            SET rating = ?, rd = ?, volatility = ?, games_played = 0, updated_at = datetime('now')`,
    ).bind(DEFAULT_RATING, DEFAULT_RD, DEFAULT_VOLATILITY).run();

    // Every stamp is rewritten below for the matches that still count; clearing first is what
    // removes stamps from a match that has just stopped counting.
    await db.prepare(
        `UPDATE match_participants SET rating_before = NULL, rating_after = NULL`,
    ).bind().run();

    const touched = new Set<string>();
    for (const { id: matchId, mode } of ids) {
        const parts = await db.prepare(
            `SELECT match_id, user_id, team, result FROM match_participants
              WHERE match_id = ? ORDER BY user_id ASC`,
        ).bind(matchId).all<ParticipantRow>();

        const isTeam = mode === 'team';
        const outcomes: ParticipantOutcome[] = (parts.results ?? []).map((p) => ({
            userId: p.user_id,
            result: p.result as 0 | 0.5 | 1,
            // Only for a team match. Handing applyMatch the 0 that every 1v1 carries
            // would put both players on the same side and skip their only pairing.
            team: isTeam ? (p.team | 0) : undefined,
        }));
        if (outcomes.length < 2) continue;

        const diff = await applyMatch(db, outcomes, isTeam ? 'team' : 'default');
        const stamps = [];
        for (const o of outcomes) {
            touched.add(o.userId);
            const d = diff.get(o.userId);
            if (!d) continue;
            stamps.push(db.prepare(
                `UPDATE match_participants SET rating_before = ?, rating_after = ?
                  WHERE match_id = ? AND user_id = ?`,
            ).bind(d.before, d.after, matchId, o.userId));
        }
        if (stamps.length) await db.batch(stamps);
    }

    return { matches: ids.length, players: touched.size };
}
