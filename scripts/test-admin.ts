/**
 * Harness for the operator commands — above all, for the rating replay they lean on.
 *
 * Run: `npx tsx scripts/test-admin.ts`
 *
 * <p><b>The test that matters is the first one.</b> `recomputeLadder` is what makes every
 * correction safe: `applyMatch` has no inverse, so "undo this match" is implemented as "replay
 * the ladder without it". That is only sound if a replay over UNCHANGED data reproduces the
 * ratings already in the database, exactly. If it does not, the replay is not faithful and no
 * correction command can be trusted — so that property is asserted before anything else.</p>
 *
 * <p>Not in `npm test`, which runs the pure ratability unit tests. This one builds a real
 * SQLite file, so it belongs beside the other `scripts/test-*.ts` harnesses.</p>
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Db } from '../src/db';
import { applyMatch } from '../src/elo/glicko2';
import { recomputeLadder, readRatings } from './admin';

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`);
    if (!ok) failures++;
}

/** Ratings compared the way a person would: to a tenth of a point. */
function sameLadder(a: Map<string, { rating: number; games_played: number }>,
                    b: Map<string, { rating: number; games_played: number }>): string | null {
    if (a.size !== b.size) return `size ${a.size} vs ${b.size}`;
    for (const [id, ra] of a) {
        const rb = b.get(id);
        if (!rb) return `${id} missing`;
        if (Math.abs(ra.rating - rb.rating) > 0.05) {
            return `${id} rating ${ra.rating.toFixed(3)} vs ${rb.rating.toFixed(3)}`;
        }
        if (ra.games_played !== rb.games_played) {
            return `${id} games ${ra.games_played} vs ${rb.games_played}`;
        }
    }
    return null;
}

interface Seeded { db: Db; dir: string; }

/**
 * Build a database that looks like one the live server produced: users with the rating row
 * signup creates, three rated 1v1s, and the ratings applied in REPORT order — which is what
 * the live path does, and what the replay has to reproduce.
 */
async function seed(): Promise<Seeded> {
    const dir = mkdtempSync(join(tmpdir(), 'wol-admin-test-'));
    const db = new Db(join(dir, 'lobby.db'));
    db.migrate('migrations');

    const users = [['u-a', 'ana'], ['u-b', 'beto'], ['u-c', 'caro']];
    for (const [id, name] of users) {
        await db.prepare(
            `INSERT INTO users (id, discord_id, discord_username, display_name)
             VALUES (?, ?, ?, ?)`,
        ).bind(id, `d-${id}`, name, name).run();
        await db.prepare(
            `INSERT INTO elo_ratings (user_id, mode) VALUES (?, 'default')`,
        ).bind(id).run();
    }

    // A closed room that still holds a member row — the shape that bars a player from every
    // future join, because the guard never checks lobby status.
    await db.prepare(
        `INSERT INTO lobbies (id, host_user_id, title, mod_id, mod_combined_hash, status, closed_at)
         VALUES ('L-DEAD', 'u-a', 'ghost', 'wol', 'h', 'closed', datetime('now'))`,
    ).bind().run();
    await db.prepare(
        `INSERT INTO lobby_members (lobby_id, user_id) VALUES ('L-DEAD', 'u-c')`,
    ).bind().run();

    // An open room nobody ever connected to.
    await db.prepare(
        `INSERT INTO lobbies (id, host_user_id, title, mod_id, mod_combined_hash, status)
         VALUES ('L-GHOST', 'u-b', 'never joined', 'wol', 'h', 'open')`,
    ).bind().run();

    const games: Array<[string, string, string]> = [
        ['m1', 'u-a', 'u-b'],   // a beats b
        ['m2', 'u-b', 'u-c'],   // b beats c
        ['m3', 'u-a', 'u-c'],   // a beats c
    ];

    let minute = 1;
    for (const [id, winner, loser] of games) {
        const at = `2026-08-01 10:0${minute}:00`;
        minute++;
        await db.prepare(
            `INSERT INTO matches (id, lobby_id, host_user_id, mod_id, mod_combined_hash,
                                  map_name, duration_seconds, started_at, ended_at, created_at,
                                  rated, unrated_reason)
             VALUES (?, NULL, ?, 'wol', 'h', 'test_map', 600, ?, ?, ?, 1, NULL)`,
        ).bind(id, winner, at, at, at).run();

        for (const [u, r] of [[winner, 1.0], [loser, 0.0]] as Array<[string, number]>) {
            await db.prepare(
                `INSERT INTO match_participants (match_id, user_id, result) VALUES (?, ?, ?)`,
            ).bind(id, u, r).run();
        }

        // The live path: rate at report time, then stamp.
        const diff = await applyMatch(db, [
            { userId: winner, result: 1 },
            { userId: loser, result: 0 },
        ]);
        for (const [uid, d] of diff) {
            await db.prepare(
                `UPDATE match_participants SET rating_before = ?, rating_after = ?
                  WHERE match_id = ? AND user_id = ?`,
            ).bind(d.before, d.after, id, uid).run();
        }
    }

    return { db, dir };
}

async function main(): Promise<void> {
    // ---- 1. fidelity: a replay of untouched history must change nothing -------------
    {
        const { db, dir } = await seed();
        const live = await readRatings(db);
        const { matches } = await recomputeLadder(db);
        const replayed = await readRatings(db);

        check('replay reads every rated match', matches === 3, `got ${matches}`);
        const drift = sameLadder(live, replayed);
        check(
            'replaying unchanged history reproduces the ladder exactly',
            drift === null,
            drift ?? '',
        );
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 2. voiding a match removes exactly its effect ------------------------------
    {
        const { db, dir } = await seed();
        const before = await readRatings(db);
        const aBefore = before.get('u-a')!.rating;

        await db.prepare(
            `UPDATE matches SET rated = 0, unrated_reason = 'voided_by_operator' WHERE id = 'm2'`,
        ).bind().run();
        await db.prepare(
            `UPDATE match_participants SET result = 0.5 WHERE match_id = 'm2'`,
        ).bind().run();
        const { matches } = await recomputeLadder(db);
        const after = await readRatings(db);

        check('a voided match drops out of the replay', matches === 2, `got ${matches}`);
        check(
            'a player who was not in it does not move',
            Math.abs(after.get('u-a')!.rating - aBefore) < 0.05,
            `${aBefore.toFixed(2)} -> ${after.get('u-a')!.rating.toFixed(2)}`,
        );
        check(
            'the players who were in it do move',
            Math.abs(after.get('u-b')!.rating - before.get('u-b')!.rating) > 0.05
            && Math.abs(after.get('u-c')!.rating - before.get('u-c')!.rating) > 0.05,
        );
        check(
            'their game counts drop by one',
            after.get('u-b')!.games_played === before.get('u-b')!.games_played - 1
            && after.get('u-c')!.games_played === before.get('u-c')!.games_played - 1,
        );

        const stamps = await db.prepare(
            `SELECT rating_after FROM match_participants WHERE match_id = 'm2'`,
        ).bind().all<{ rating_after: number | null }>();
        check(
            'the voided match keeps no rating stamps',
            (stamps.results ?? []).every((r) => r.rating_after === null),
        );
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 3. flipping a result is symmetric ------------------------------------------
    {
        const { db, dir } = await seed();
        const before = await readRatings(db);

        // m1 read the wrong way round: give it to b instead of a.
        await db.prepare(
            `UPDATE match_participants SET result = 0.0 WHERE match_id = 'm1' AND user_id = 'u-a'`,
        ).bind().run();
        await db.prepare(
            `UPDATE match_participants SET result = 1.0 WHERE match_id = 'm1' AND user_id = 'u-b'`,
        ).bind().run();
        await recomputeLadder(db);
        const after = await readRatings(db);

        check(
            'reversing a result sends the winner down and the loser up',
            after.get('u-a')!.rating < before.get('u-a')!.rating
            && after.get('u-b')!.rating > before.get('u-b')!.rating,
        );
        check(
            'nobody gains or loses a game from a result change',
            after.get('u-a')!.games_played === before.get('u-a')!.games_played
            && after.get('u-b')!.games_played === before.get('u-b')!.games_played,
        );
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 4. the replay is deterministic ---------------------------------------------
    {
        const { db, dir } = await seed();
        await recomputeLadder(db);
        const once = await readRatings(db);
        await recomputeLadder(db);
        const twice = await readRatings(db);
        const drift = sameLadder(once, twice);
        check('replaying twice gives the same ladder', drift === null, drift ?? '');
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 5. a player with no matches keeps their signup row --------------------------
    {
        const { db, dir } = await seed();
        await db.prepare(
            `INSERT INTO users (id, discord_id, discord_username, display_name)
             VALUES ('u-z', 'd-z', 'zoe', 'zoe')`,
        ).bind().run();
        await db.prepare(
            `INSERT INTO elo_ratings (user_id, mode) VALUES ('u-z', 'default')`,
        ).bind().run();

        await recomputeLadder(db);
        const after = await readRatings(db);
        check(
            'a player who never played keeps a row at the default rating',
            after.has('u-z') && Math.abs(after.get('u-z')!.rating - 1500) < 0.05
            && after.get('u-z')!.games_played === 0,
        );
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    console.log(`\n${failures === 0 ? 'all good' : `${failures} failure(s)`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
