/**
 * Standalone check of the ladder's PEAK column (src/stats/ratingPeaks.ts) against a real database.
 * Run: `npx tsx scripts/test-rating-peaks.ts`.
 *
 * Same rig as scripts/test-placement-privacy.ts: an in-memory SQLite DB with every migration. The
 * unit tests pin the grouping and the shape of the SQL; this pins that the SQL actually reads the
 * matches and refunds the profile's peak reads — and nothing else.
 *
 * Cast: A has finished 1v1 placement, with a placement swing that must not count, an unrated match
 * and a team match that must not count, one refund that sets his peak and a revoked one that must
 * not. B is 3 matches into placement. X has no match at all.
 */
import { Db } from '../src/db';
import { ratingPeaks } from '../src/stats/ratingPeaks';
import { placementRequired } from '../src/elo/placement';
import type { AppContext } from '../src/context';

let failures = 0;
function check(label: string, cond: boolean): void {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
    if (!cond) failures++;
}

const at = (day: number) => `2026-09-${String(day).padStart(2, '0')} 12:00:00`;

async function main(): Promise<void> {
    const db = new Db(':memory:');
    db.migrate('migrations');
    const raw = db.raw();

    for (const id of ['A', 'B', 'X']) {
        raw.prepare(
            `INSERT INTO users (id, discord_id, discord_username, display_name) VALUES (?, ?, ?, ?)`,
        ).run(id, `dc-${id}`, `User${id}`, `User${id}`);
    }

    let n = 0;
    const match = (user: string, day: number, after: number, rated = 1, mode: string | null = 'default') => {
        const id = `m${++n}`;
        raw.prepare(
            `INSERT INTO matches (id, host_user_id, mod_id, mod_combined_hash, started_at, ended_at,
                                  created_at, rated, rating_mode)
             VALUES (?, ?, 'wol', 'hash', ?, ?, ?, ?, ?)`,
        ).run(id, user, at(day), at(day), at(day), rated, mode);
        raw.prepare(
            `INSERT INTO match_participants (match_id, user_id, result, rating_before, rating_after)
             VALUES (?, ?, 1.0, ?, ?)`,
        ).run(id, user, after - 10, after);
    };

    // A: placement plus two. The third match is a placement swing to 2100 (does not count); after
    // placement the ratings climb to 1700 and fall back to 1690. One match has no rating_mode at
    // all, which the profile reads as 1v1 — so must this.
    const required = placementRequired('default');
    for (let i = 0; i < required + 2; i++) {
        const after = i === 2 ? 2100 : i === required + 1 ? 1690 : 1500 + 20 * i;
        match('A', i + 1, after, 1, i === required ? null : 'default');
    }
    match('A', 20, 2500, 0);              // unrated: never counts
    match('A', 21, 2400, 1, 'team');      // the other ladder

    // B: still being placed on 1v1.
    for (let i = 0; i < 3; i++) match('B', i + 1, 1500 + 10 * i);

    // Refunds for A: one that becomes his peak, a revoked one, and one on the team ladder.
    const refund = (id: string, day: number, revokedDay: number | null, mode: string, after: number) => {
        raw.prepare(
            `INSERT INTO ban_refunds (id, banned_user_id, created_at, revoked_at) VALUES (?, 'X', ?, ?)`,
        ).run(id, at(day), revokedDay === null ? null : at(revokedDay));
        raw.prepare(
            `INSERT INTO rating_refunds (refund_id, user_id, mode, points, matches, rating_before, rating_after)
             VALUES (?, 'A', ?, ?, 1, ?, ?)`,
        ).run(id, mode, 50, after - 50, after);
    };
    refund('R1', 25, null, 'default', 1750);
    refund('R2', 26, 27, 'default', 1900);   // revoked
    refund('R3', 28, null, 'team', 2600);    // the other ladder

    const ctx = { db } as unknown as AppContext;

    const solo = await ratingPeaks(ctx, ['A', 'B', 'X'], 'default');
    check(`A's 1v1 peak is his live refund: ${JSON.stringify(solo.get('A'))}`,
        solo.get('A')?.peak === 1750 && solo.get('A')?.peakAt === '2026-09-25T12:00:00Z');
    check('B, still being placed, has no peak',
        solo.get('B')?.peak === null && solo.get('B')?.peakAt === null);
    check('X, with no rated match, is absent', !solo.has('X'));

    // Without the refunds, the best match after placement — not the placement swing, not the last.
    raw.prepare(`DELETE FROM rating_refunds`).run();
    const matchesOnly = await ratingPeaks(ctx, ['A'], 'default');
    check(`without refunds A's peak is 1700, reached on day 11: ${JSON.stringify(matchesOnly.get('A'))}`,
        matchesOnly.get('A')?.peak === 1700 && matchesOnly.get('A')?.peakAt === '2026-09-11T12:00:00Z');

    const team = await ratingPeaks(ctx, ['A'], 'team');
    check('one team match is still placement on the team ladder',
        team.get('A')?.peak === null);

    check('an empty page asks nothing and answers nothing', (await ratingPeaks(ctx, [], 'default')).size === 0);

    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
