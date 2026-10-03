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
 * Replaying by report order is the faithful reproduction. The same column files each match into
 * its season (src/elo/seasons.ts), so a replay rebuilds every season in order and each one's
 * first matches start from the soft reset of the season before.</p>
 *
 * <p><b>It rebuilds FROM a season, never less than that season.</b> `fromSeason = k` deletes the
 * rows of season k and every later one, clears the stamps of the matches stored since k began,
 * and replays exactly those matches. Every season before k is left byte-for-byte as it was: its
 * rows, and its matches' stamps. That is what lets an ended season's table be a permanent record
 * — the automatic corrections on the server pass the CURRENT season and so can never reach a
 * closed one, while an operator correcting an old match passes that match's season and gets every
 * later season re-derived from the corrected result.</p>
 *
 * <p>Rows are deleted rather than reset: a season's rows are the players who played a rated match
 * in it and nobody else, and that is exactly what the replay recreates.</p>
 *
 * <p><b>Inside the server it runs under {@link withLadderLock}.</b> A replay resets every
 * rating and rebuilds them one match at a time; a report rating a match halfway through that
 * would be applied to a half-built ladder and then overwritten. The lock is in-process, which
 * is the whole process — this server is one Node.</p>
 */
import { applyMatch, type ParticipantOutcome } from './glicko2';
import { boundsAsSql, FIRST_SEASON, seasonOfCreatedAt } from './seasons';
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

export interface ReplayOptions {
    /**
     * The first season to rebuild. Every season before it is untouched. Defaults to Season 1 —
     * the whole history — which is what an operator's `elo:recompute` means.
     */
    fromSeason?: number;
}

export async function recomputeLadder(
    db: Db,
    opts: ReplayOptions = {},
): Promise<{ matches: number; players: number; fromSeason: number }> {
    const fromSeason = Math.max(FIRST_SEASON, Math.floor(opts.fromSeason ?? FIRST_SEASON));
    // Null for Season 1, which has no beginning: everything ever stored is in range.
    const start = boundsAsSql(fromSeason).start;
    const since = start === null ? '' : ' AND created_at >= ?';
    const sinceArgs = start === null ? [] : [start];

    // rating_mode travels with each match so the replay can feed it to the ladder it
    // actually belongs to. NULL means a row written before migration 0010, all of which
    // were 1v1 — so it reads as 'default' rather than as unknown.
    //
    // Fetched BEFORE the stamps are cleared below. The `rated IS NULL` branch recognises the
    // matches from before migration 0006 by those stamps; migration 0024 wrote `rated = 1` for
    // every one of them, so a replay that dies half-way can no longer lose them, but the branch
    // stays for a database restored from before that migration.
    const rated = await db.prepare(
        `SELECT id, created_at, COALESCE(rating_mode, 'default') AS rating_mode FROM matches
          WHERE (rated = 1
             OR (rated IS NULL AND EXISTS (
                    SELECT 1 FROM match_participants p
                     WHERE p.match_id = matches.id AND p.rating_after IS NOT NULL)))${since}
          ORDER BY created_at ASC, id ASC`,
    ).bind(...sinceArgs).all<{ id: string; created_at: string; rating_mode: string }>();

    const list = rated.results ?? [];

    // Both ladders of every season being rebuilt, and nothing else. This is correct only because
    // the loop below feeds every match back into its own mode AND its own season — narrowing the
    // replay to one ladder without narrowing this statement would wipe the other on its way past.
    await db.prepare(`DELETE FROM season_ratings WHERE season >= ?`).bind(fromSeason).run();

    // Every stamp in range is rewritten below for the matches that still count; clearing first
    // is what removes stamps from a match that has just stopped counting. Matches of earlier
    // seasons keep theirs: their season is not being touched.
    await db.prepare(
        start === null
            ? `UPDATE match_participants SET rating_before = NULL, rating_after = NULL`
            : `UPDATE match_participants SET rating_before = NULL, rating_after = NULL
                WHERE match_id IN (SELECT id FROM matches WHERE created_at >= ?)`,
    ).bind(...sinceArgs).run();

    const touched = new Set<string>();
    for (const { id: matchId, created_at: createdAt, rating_mode: mode } of list) {
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

        const diff = await applyMatch(
            db, outcomes, isTeam ? 'team' : 'default', seasonOfCreatedAt(createdAt));
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

    return { matches: list.length, players: touched.size, fromSeason };
}
