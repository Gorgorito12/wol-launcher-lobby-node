/**
 * Harness for the operator commands — above all, for the rating replay they lean on — and for
 * rating seasons, which only a real database can exercise.
 *
 * Run: `npx tsx scripts/test-admin.ts`
 *
 * <p><b>The test that matters is the first one.</b> `recomputeLadder` is what makes every
 * correction safe: `applyMatch` has no inverse, so "undo this match" is implemented as "replay
 * the ladder without it". That is only sound if a replay over UNCHANGED data reproduces the
 * ratings already in the database, exactly. If it does not, the replay is not faithful and no
 * correction command can be trusted — so that property is asserted before anything else, and
 * asserted again across a season boundary.</p>
 *
 * <p>Not in `npm test`, which runs the pure unit tests. This one builds a real SQLite file, so it
 * belongs beside the other `scripts/test-*.ts` harnesses.</p>
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyBaseLogger } from 'fastify';
import { Db } from '../src/db';
import { applyMatch, effectiveRatings, DEFAULT_RATING, type RatingMode } from '../src/elo/glicko2';
import { SEASON_2_START, seasonOfCreatedAt, softReset } from '../src/elo/seasons';
import type { AppContext } from '../src/context';
import { LOBBY_LIST_SQL } from '../src/lobbies/rest';
import { MEMBER_HELLO_SQL } from '../src/lobbies/LobbyRoom';
import { latePathsForTests } from '../src/matches/rest';
import {
    ladderRanks, ladderSize, pastSeasonsFor, seasonTitlesAll, seasonTable,
} from '../src/stats/rest';
import { decideTeamMatch, recomputeLadder, readRatings, type TeamRefusal } from './admin';

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

/** A user row. No rating row: a player gets one with his first rated match of a season. */
async function addUser(db: Db, id: string, name: string): Promise<void> {
    await db.prepare(
        `INSERT INTO users (id, discord_id, discord_username, display_name) VALUES (?, ?, ?, ?)`,
    ).bind(id, `d-${id}`, name, name).run();
}

/**
 * Store a rated 1v1 at `at` and rate it the way the live path does: in the season its own
 * created_at files it into, at report time, then stamp.
 */
async function playRated(db: Db, id: string, winner: string, loser: string, at: string): Promise<void> {
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

    const diff = await applyMatch(db, [
        { userId: winner, result: 1 },
        { userId: loser, result: 0 },
    ], 'default', seasonOfCreatedAt(at));
    for (const [uid, d] of diff) {
        await db.prepare(
            `UPDATE match_participants SET rating_before = ?, rating_after = ?
              WHERE match_id = ? AND user_id = ?`,
        ).bind(d.before, d.after, id, uid).run();
    }
}

/**
 * Build a database that looks like one the live server produced: three users, three rated 1v1s
 * in Season 1, and the ratings applied in REPORT order — which is what the live path does, and
 * what the replay has to reproduce.
 */
async function seed(): Promise<Seeded> {
    const dir = mkdtempSync(join(tmpdir(), 'wol-admin-test-'));
    const db = new Db(join(dir, 'lobby.db'));
    db.migrate('migrations');

    for (const [id, name] of [['u-a', 'ana'], ['u-b', 'beto'], ['u-c', 'caro']]) {
        await addUser(db, id!, name!);
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

    await playRated(db, 'm1', 'u-a', 'u-b', '2026-08-01 10:01:00');   // a beats b
    await playRated(db, 'm2', 'u-b', 'u-c', '2026-08-01 10:02:00');   // b beats c
    await playRated(db, 'm3', 'u-a', 'u-c', '2026-08-01 10:03:00');   // a beats c

    return { db, dir };
}

/**
 * A 2v2 or 3v3 stored the way POST /matches stores one whose sides the launcher could not
 * read: everybody on team 0 with a 0.5, refused `not_1v1`, and `rating_mode = 'default'`,
 * because a shape the server refuses is filed under the 1v1 ladder.
 */
async function addUnreadTeamMatch(db: Db, id: string, players: string[], at: string): Promise<void> {
    await db.prepare(
        `INSERT INTO matches (id, lobby_id, host_user_id, mod_id, mod_combined_hash,
                              map_name, duration_seconds, started_at, ended_at, created_at,
                              rated, unrated_reason, rating_mode)
         VALUES (?, NULL, ?, 'wol', 'h', 'test_map', 1200, ?, ?, ?, 0, 'not_1v1', 'default')`,
    ).bind(id, players[0], at, at, at).run();
    for (const u of players) {
        await db.prepare(
            `INSERT INTO match_participants (match_id, user_id, team, result) VALUES (?, ?, 0, 0.5)`,
        ).bind(id, u).run();
    }
}

/** Every row a decision could write, in a fixed order. Equal before and after = nothing written. */
async function stateOf(db: Db): Promise<string> {
    const read = async (sql: string): Promise<unknown[]> => (await db.prepare(sql).bind().all()).results;
    return JSON.stringify([
        await read(`SELECT * FROM matches ORDER BY id`),
        await read(`SELECT * FROM match_participants ORDER BY match_id, user_id`),
        await read(`SELECT user_id, mode, season, rating, rd, volatility, games_played
                      FROM season_ratings ORDER BY user_id, mode, season`),
    ]);
}

/** One season's rows and its matches' stamps, to the last bit — "this season was not touched". */
async function seasonState(db: Db, season: number, before: string): Promise<string> {
    const rows = await db.prepare(
        `SELECT user_id, mode, rating, rd, volatility, games_played FROM season_ratings
          WHERE season = ? ORDER BY user_id, mode`,
    ).bind(season).all();
    const stamps = await db.prepare(
        `SELECT p.match_id, p.user_id, p.rating_before, p.rating_after
           FROM match_participants p JOIN matches m ON m.id = p.match_id
          WHERE m.created_at < ? ORDER BY p.match_id, p.user_id`,
    ).bind(before).all();
    return JSON.stringify([rows.results, stamps.results]);
}

/** The same ladder to the last bit (rating, deviation and games), for "exactly unchanged". */
function identicalLadder(a: Map<string, { rating: number; rd: number; games_played: number }>,
                         b: Map<string, { rating: number; rd: number; games_played: number }>): string | null {
    if (a.size !== b.size) return `size ${a.size} vs ${b.size}`;
    for (const [id, ra] of a) {
        const rb = b.get(id);
        if (!rb) return `${id} missing`;
        if (ra.rating !== rb.rating || ra.rd !== rb.rd || ra.games_played !== rb.games_played) {
            return `${id} ${ra.rating}/${ra.rd}/${ra.games_played} vs ${rb.rating}/${rb.rd}/${rb.games_played}`;
        }
    }
    return null;
}

/** A context good enough for the readers and the late rating paths: the database, and two
 *  announcement sinks the test can look at. */
function fakeContext(db: Db, announced: unknown[]): AppContext {
    return {
        db,
        config: { rankedModIds: ['wol'] },
        rooms: { get: () => undefined },
        globalChat: {
            announceMatchRated: (n: unknown) => { announced.push(n); },
            announceTournamentUpdate: () => {},
        },
    } as unknown as AppContext;
}

const quietLog = { info() {}, warn() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger;

/** Rating of one player on one ladder in one season, NaN when he has no row there. */
async function ratingIn(db: Db, user: string, season: number, mode: RatingMode = 'default'): Promise<number> {
    return (await readRatings(db, mode, season)).get(user)?.rating ?? NaN;
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
        // The ladder must be EXACTLY the one a history without that match would have produced.
        // (This check used to read "a player who was not in it does not move", which Glicko
        // does not promise: a beat c in m3, after m2, and c's rating going into m3 depends on
        // m2 — so a moves too, 1709.31 -> 1750.54, as the library alone confirms. The property
        // that matters is that the void removes the match and nothing else.)
        {
            const ref = new Db(join(dir, 'reference.db'));
            ref.migrate('migrations');
            for (const [id, name] of [['u-a', 'ana'], ['u-b', 'beto'], ['u-c', 'caro']]) {
                await addUser(ref, id!, name!);
            }
            await playRated(ref, 'm1', 'u-a', 'u-b', '2026-08-01 10:01:00');
            await playRated(ref, 'm3', 'u-a', 'u-c', '2026-08-01 10:03:00');
            const drift = sameLadder(await readRatings(ref), after);
            check(
                'voiding a match gives exactly the ladder of a history without it',
                drift === null,
                drift ?? `a ${aBefore.toFixed(2)} -> ${after.get('u-a')!.rating.toFixed(2)}`,
            );
            ref.close();
        }
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

    // ---- 5. a player with no matches has no row, and reads as the default -----------
    {
        const { db, dir } = await seed();
        await addUser(db, 'u-z', 'zoe');

        await recomputeLadder(db);
        const after = await readRatings(db);
        const eff = (await effectiveRatings(db, ['u-z'], 'default', 1)).get('u-z');
        check(
            'a player who never played has no rating row and reads as the starting 1500',
            !after.has('u-z') && eff?.source === 'default'
            && Math.abs(eff.rating - DEFAULT_RATING) < 0.05 && eff.games_played === 0,
            JSON.stringify(eff),
        );
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 6. a 2v2 the launcher could not read is rated by hand ----------------------
    {
        const { db, dir } = await seed();
        await addUser(db, 'u-d', 'dani');
        // Between m1 and m2 in report order, so the replay interleaves it with the 1v1s —
        // which is exactly what "the 1v1 ladder is unchanged" below has to survive.
        const four = ['u-a', 'u-b', 'u-c', 'u-d'];
        await addUnreadTeamMatch(db, 't1', four, '2026-08-01 10:02:30');

        const soloBefore = await readRatings(db);
        const teamBefore = await readRatings(db, 'team');

        const d = await decideTeamMatch(db, 't1', ['u-c', 'u-d']);
        check('a 2v2 with its losing side named is decided', d.ok, d.ok ? '' : d.error);
        check(
            'the winners are everyone in the match who was not named',
            d.ok && d.winners.map((p) => p.userId).join() === 'u-a,u-b'
            && d.losers.map((p) => p.userId).join() === 'u-c,u-d',
        );

        const row = await db.prepare(
            `SELECT rated, unrated_reason, rating_mode, decided_by FROM matches WHERE id = 't1'`,
        ).bind().first<{ rated: number; unrated_reason: string | null; rating_mode: string; decided_by: string }>();
        check(
            'the match is stored rated, on the team ladder, decided by the operator',
            row?.rated === 1 && row.unrated_reason === null
            && row.rating_mode === 'team' && row.decided_by === 'operator',
            JSON.stringify(row),
        );

        const sides = await db.prepare(
            `SELECT user_id, team, result FROM match_participants WHERE match_id = 't1' ORDER BY user_id`,
        ).bind().all<{ user_id: string; team: number; result: number }>();
        check(
            'winners are team 0 with 1.0 and losers team 1 with 0.0',
            (sides.results ?? []).map((p) => `${p.user_id}:${p.team}:${p.result}`).join()
            === 'u-a:0:1,u-b:0:1,u-c:1:0,u-d:1:0',
            JSON.stringify(sides.results),
        );

        const { matches } = await recomputeLadder(db);
        const solo = await readRatings(db);
        const team = await readRatings(db, 'team');

        check('the replay counts it as a rated match', matches === 4, `got ${matches}`);
        check(
            'all four have a team rating with one game, and nobody else does',
            team.size === 4 && four.every((id) => team.get(id)?.games_played === 1),
            [...team.keys()].join(),
        );
        // NaN for a missing row, so a player who never reached the team ladder FAILs the
        // comparison instead of crashing the harness before the checks after it can run.
        const start = (id: string): number => teamBefore.get(id)?.rating ?? DEFAULT_RATING;
        const now = (id: string): number => team.get(id)?.rating ?? NaN;
        const moves = (ids: string[]): string =>
            ids.map((id) => `${id} ${start(id)} -> ${now(id).toFixed(1)}`).join('; ');
        check(
            'the winners end above where they started on the team ladder',
            ['u-a', 'u-b'].every((id) => now(id) > start(id)),
            moves(['u-a', 'u-b']),
        );
        check(
            'the losers end below where they started on the team ladder',
            ['u-c', 'u-d'].every((id) => now(id) < start(id)),
            moves(['u-c', 'u-d']),
        );
        const drift = identicalLadder(soloBefore, solo);
        check('the 1v1 ladder is exactly unchanged', drift === null, drift ?? '');

        const stamps = await db.prepare(
            `SELECT rating_before, rating_after FROM match_participants WHERE match_id = 't1'`,
        ).bind().all<{ rating_before: number | null; rating_after: number | null }>();
        check(
            'the match carries the team ratings the replay gave it',
            (stamps.results ?? []).length === 4
            && (stamps.results ?? []).every((s) => s.rating_before !== null && s.rating_after !== null),
        );
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 7. every refusal writes nothing ---------------------------------------------
    {
        const { db, dir } = await seed();
        await addUser(db, 'u-d', 'dani');
        await addUser(db, 'u-z', 'zoe');   // signed up, never in the match below
        await addUnreadTeamMatch(db, 't1', ['u-a', 'u-b', 'u-c', 'u-d'], '2026-08-01 10:02:30');

        const cases: Array<[string, string, string[], TeamRefusal]> = [
            ['one loser named for a 2v2', 't1', ['u-c'], 'wrong_loser_count'],
            ['three losers named for a 2v2', 't1', ['u-b', 'u-c', 'u-d'], 'wrong_loser_count'],
            // Two names, so only the "did they play" rule can refuse it.
            ['a loser who did not play', 't1', ['u-c', 'u-z'], 'did_not_play'],
            ['the same loser named twice', 't1', ['u-c', 'u-c'], 'named_twice'],
            ['a 2-player match', 'm1', ['u-b'], 'not_a_team_match'],
            ['a match that does not exist', 'nope', ['u-c', 'u-d'], 'no_match'],
        ];
        for (const [label, matchId, losers, reason] of cases) {
            const before = await stateOf(db);
            const d = await decideTeamMatch(db, matchId, losers);
            const untouched = before === await stateOf(db);
            const refusedRight = !d.ok && d.reason === reason;
            check(
                `refused, and nothing written: ${label}`,
                refusedRight && untouched,
                !refusedRight
                    ? (d.ok ? 'it was decided' : `refused as ${d.reason}: ${d.error}`)
                    : untouched ? '' : 'the database changed',
            );
        }
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 8. a 3v3 is decided the same way -----------------------------------------------
    {
        const { db, dir } = await seed();
        for (const [id, name] of [['u-d', 'dani'], ['u-e', 'eli'], ['u-f', 'fede']] as Array<[string, string]>) {
            await addUser(db, id, name);
        }
        const six = ['u-a', 'u-b', 'u-c', 'u-d', 'u-e', 'u-f'];
        await addUnreadTeamMatch(db, 't3', six, '2026-08-01 10:04:00');

        const short = await decideTeamMatch(db, 't3', ['u-e', 'u-f']);
        check('a 3v3 refuses two losers', !short.ok && short.reason === 'wrong_loser_count');

        const d = await decideTeamMatch(db, 't3', ['u-d', 'u-e', 'u-f']);
        check('a 3v3 with its losing side named is decided', d.ok, d.ok ? '' : d.error);
        await recomputeLadder(db);
        const team = await readRatings(db, 'team');
        check(
            'all six land on the team ladder, the winners above the start and the losers below',
            team.size === 6
            && ['u-a', 'u-b', 'u-c'].every((id) => (team.get(id)?.rating ?? NaN) > DEFAULT_RATING)
            && ['u-d', 'u-e', 'u-f'].every((id) => (team.get(id)?.rating ?? NaN) < DEFAULT_RATING),
            six.map((id) => `${id} ${team.get(id)?.rating.toFixed(1) ?? '-'}`).join('; '),
        );
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ================================================================ seasons

    // ---- 9. a new season starts from the soft reset — and the stamp says so -------------
    {
        const { db, dir } = await seed();
        const aEnd = await ratingIn(db, 'u-a', 1);
        const cEnd = await ratingIn(db, 'u-c', 1);

        await playRated(db, 's2a', 'u-c', 'u-a', '2026-12-02 20:00:00');

        const stamp = await db.prepare(
            `SELECT user_id, rating_before FROM match_participants WHERE match_id = 's2a' ORDER BY user_id`,
        ).bind().all<{ user_id: string; rating_before: number }>();
        const before = new Map((stamp.results ?? []).map((r) => [r.user_id, r.rating_before]));
        const aStart = softReset({ rating: aEnd, rd: 0, volatility: 0.06 }).rating;
        const cStart = softReset({ rating: cEnd, rd: 0, volatility: 0.06 }).rating;
        check(
            "THE ONE THAT MATTERS: a player's first match of a season starts from the soft reset",
            Math.abs((before.get('u-a') ?? NaN) - aStart) < 0.001
            && Math.abs((before.get('u-c') ?? NaN) - cStart) < 0.001,
            `a ${before.get('u-a')} vs ${aStart}; c ${before.get('u-c')} vs ${cStart}`,
        );

        const s2 = await readRatings(db, 'default', 2);
        check(
            'the new season has rows only for who played in it, one game each',
            s2.size === 2 && s2.get('u-a')?.games_played === 1 && s2.get('u-c')?.games_played === 1,
            [...s2.keys()].join(),
        );
        check(
            'Season 1 keeps its final rows untouched',
            Math.abs((await ratingIn(db, 'u-a', 1)) - aEnd) < 1e-9
            && Math.abs((await ratingIn(db, 'u-c', 1)) - cEnd) < 1e-9,
        );

        // And the number the profile shows before that first match is the same number.
        const bEff = (await effectiveRatings(db, ['u-b'], 'default', 2)).get('u-b')!;
        check(
            'a carried player reads as the soft-reset number, with no games this season',
            bEff.source === 'carried' && bEff.games_played === 0
            && Math.abs(bEff.rating - softReset({
                rating: await ratingIn(db, 'u-b', 1), rd: 0, volatility: 0.06 }).rating) < 0.001,
            JSON.stringify(bEff),
        );
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 10. replay fidelity across a boundary, every season and both ladders ----------
    {
        const { db, dir } = await seed();
        await playRated(db, 's2a', 'u-c', 'u-a', '2026-12-02 20:00:00');
        await playRated(db, 's2b', 'u-b', 'u-c', '2027-01-15 21:00:00');
        await playRated(db, 's3a', 'u-a', 'u-b', '2027-03-10 18:00:00');

        const live = [1, 2, 3].map(async (n) => [n, await readRatings(db, 'default', n)] as const);
        const before = await Promise.all(live);
        const { matches } = await recomputeLadder(db);
        let drift: string | null = null;
        for (const [n, ladder] of before) {
            const d = identicalLadder(ladder, await readRatings(db, 'default', n));
            if (d) { drift = `season ${n}: ${d}`; break; }
        }
        check('a full replay reads every season\'s matches', matches === 6, `got ${matches}`);
        check('replaying unchanged history reproduces EVERY season exactly', drift === null, drift ?? '');
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 11. a row with no games carries nothing ----------------------------------------
    {
        const { db, dir } = await seed();
        await addUser(db, 'u-r', 'reset');
        // What `player:reset` leaves: a row with no games — here at a rating that would matter.
        await db.prepare(
            `INSERT INTO season_ratings (user_id, mode, season, rating, rd, volatility, games_played)
             VALUES ('u-r', 'default', 1, 1900, 120, 0.06, 0)`,
        ).bind().run();
        const eff = (await effectiveRatings(db, ['u-r'], 'default', 2)).get('u-r')!;
        check(
            'a season with no games carries nothing into the next one',
            eff.source === 'default' && Math.abs(eff.rating - DEFAULT_RATING) < 0.05,
            JSON.stringify(eff),
        );
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 12. skipping a season carries once -----------------------------------------------
    {
        const { db, dir } = await seed();
        const aEnd = await ratingIn(db, 'u-a', 1);
        const bEnd = await ratingIn(db, 'u-b', 1);
        // Nothing in Season 2. Back in Season 3.
        await playRated(db, 's3a', 'u-a', 'u-b', '2027-03-10 18:00:00');
        const stamp = await db.prepare(
            `SELECT rating_before FROM match_participants WHERE match_id = 's3a' AND user_id = 'u-a'`,
        ).bind().first<{ rating_before: number }>();
        const once = softReset({ rating: aEnd, rd: 0, volatility: 0.06 }).rating;
        check(
            'a player who skipped a season starts from ONE soft reset of the last one he played',
            Math.abs((stamp?.rating_before ?? NaN) - once) < 0.001,
            `${stamp?.rating_before} vs ${once} (two would be ${softReset({ rating: once, rd: 0, volatility: 0.06 }).rating})`,
        );
        check('and Season 2 has no rows at all', (await readRatings(db, 'default', 2)).size === 0);
        check('nor did Season 1 move', Math.abs((await ratingIn(db, 'u-b', 1)) - bEnd) < 1e-9);
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 13. a replay from Season 2 leaves Season 1 byte-identical ------------------------
    {
        const { db, dir } = await seed();
        await playRated(db, 's2a', 'u-c', 'u-a', '2026-12-02 20:00:00');
        await playRated(db, 's2b', 'u-b', 'u-c', '2027-01-15 21:00:00');
        const boundary = '2026-12-01 06:00:00';
        const s1Before = await seasonState(db, 1, boundary);
        const s2Before = await readRatings(db, 'default', 2);

        // Void a Season 2 match and replay from Season 2 — what the server does for a crash void.
        await db.prepare(`UPDATE matches SET rated = 0, unrated_reason = 'game_crashed' WHERE id = 's2b'`)
            .bind().run();
        const { matches, fromSeason } = await recomputeLadder(db, { fromSeason: 2 });

        check('a scoped replay reads only the matches from its season on', matches === 1 && fromSeason === 2,
            `matches ${matches}, from ${fromSeason}`);
        check(
            'THE RECORD: Season 1\'s rows and stamps are byte-for-byte untouched',
            s1Before === await seasonState(db, 1, boundary),
        );
        const s2After = await readRatings(db, 'default', 2);
        check(
            'Season 2 is rebuilt without the voided match',
            s2After.size === 2 && s2After.get('u-b') === undefined
            && s2After.get('u-c')?.games_played === 1 && s2Before.get('u-c')?.games_played === 2,
            [...s2After.entries()].map(([id, r]) => `${id}:${r.games_played}`).join(' '),
        );
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 14. an operator correction of a Season 1 match re-derives Season 2 ----------------
    {
        const { db, dir } = await seed();
        await playRated(db, 's2a', 'u-a', 'u-c', '2026-12-02 20:00:00');
        const aS1 = await ratingIn(db, 'u-a', 1);
        const aS2 = await ratingIn(db, 'u-a', 2);

        // m1 read the wrong way round, corrected by hand: a LOST to b.
        await db.prepare(`UPDATE match_participants SET result = 0.0 WHERE match_id = 'm1' AND user_id = 'u-a'`)
            .bind().run();
        await db.prepare(`UPDATE match_participants SET result = 1.0 WHERE match_id = 'm1' AND user_id = 'u-b'`)
            .bind().run();
        await recomputeLadder(db, { fromSeason: seasonOfCreatedAt('2026-08-01 10:01:00') });

        const aS1After = await ratingIn(db, 'u-a', 1);
        const aS2After = await ratingIn(db, 'u-a', 2);
        check('the corrected Season 1 match moves Season 1', aS1After < aS1,
            `${aS1.toFixed(1)} -> ${aS1After.toFixed(1)}`);
        check(
            'and Season 2 is re-derived from the corrected finish, not left stale',
            aS2After < aS2,
            `${aS2.toFixed(1)} -> ${aS2After.toFixed(1)}`,
        );
        const stamp = await db.prepare(
            `SELECT rating_before FROM match_participants WHERE match_id = 's2a' AND user_id = 'u-a'`,
        ).bind().first<{ rating_before: number }>();
        check(
            'the Season 2 stamp starts from the soft reset of the CORRECTED Season 1',
            Math.abs((stamp?.rating_before ?? NaN)
                - softReset({ rating: aS1After, rd: 0, volatility: 0.06 }).rating) < 0.001,
        );
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 15. with two seasons of data, every reader answers ONE row per player ------------
    {
        const { db, dir } = await seed();
        await playRated(db, 's2a', 'u-c', 'u-a', '2026-12-02 20:00:00');
        await playRated(db, 's2b', 'u-b', 'u-c', '2027-01-15 21:00:00');
        const ctx = fakeContext(db, []);
        const inSeason3 = Date.parse('2027-03-15T12:00:00Z');

        const ranks = await ladderRanks(ctx, ['u-a', 'u-b', 'u-c'], 'default', 2);
        check(
            'positions are the season\'s own table: three players, three places',
            [...ranks.values()].sort().join() === '1,2,3',
            JSON.stringify([...ranks]),
        );
        check('the size is the season\'s, not the sum of two', await ladderSize(ctx, 'default', 2) === 3
            && await ladderSize(ctx, 'default', 1) === 3);

        const eff = await effectiveRatings(db, ['u-a', 'u-b', 'u-c'], 'default', 2);
        check('one effective rating per player', eff.size === 3);

        const hosts = await db.prepare(LOBBY_LIST_SQL).bind().all<{ id: string }>();
        check(
            'the rooms list lists each room once, whatever its host has played',
            (hosts.results ?? []).length === 1 && hosts.results![0]!.id === 'L-GHOST',
            JSON.stringify(hosts.results),
        );
        await db.prepare(`INSERT INTO lobby_members (lobby_id, user_id) VALUES ('L-GHOST', 'u-b')`)
            .bind().run();
        const hello = await db.prepare(MEMBER_HELLO_SQL).bind('L-GHOST', 'u-b').all();
        check('the hello finds the member exactly once', (hello.results ?? []).length === 1);

        const past = await pastSeasonsFor(ctx, 'u-a', inSeason3);
        check(
            'the history lists each ended season once, with its final place and record',
            past.map((p) => `${p.season}:${p.mode}`).join() === '2:default,1:default'
            && past.every((p) => p.size === 3)
            && past.find((p) => p.season === 1)!.wins === 2,
            JSON.stringify(past),
        );
        const titles = await seasonTitlesAll(ctx, ['u-a', 'u-b', 'u-c'], inSeason3);
        check(
            'every top-3 finish is a medal: three players, two seasons, six medals',
            [...titles.values()].reduce((n, l) => n + l.length, 0) === 6,
        );
        const table = await seasonTable(ctx, 1, 'default', 50, inSeason3);
        check(
            'an ended season\'s table carries the places in order and the season\'s record',
            table.map((r) => r.rank).join() === '1,2,3'
            && table.find((r) => r.user_id === 'u-a')!.season_wins === 2,
            JSON.stringify(table.map((r) => [r.rank, r.user_id, r.season_wins, r.season_losses])),
        );
        // While Season 1 is still running, it has no final table yet.
        const notYet = await pastSeasonsFor(ctx, 'u-a', Date.parse('2026-10-01T00:00:00Z'));
        check('a season that is still running is not in anybody\'s history', notYet.length === 0);
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 16. a team match corroborated after the boundary keeps its result, rates nothing --
    {
        for (const [label, nowIso, expectRated] of [
            ['corroborated before the boundary', '2026-12-01T05:59:00Z', true],
            ['corroborated AFTER the boundary', '2026-12-01T06:02:00Z', false],
        ] as Array<[string, string, boolean]>) {
            const { db, dir } = await seed();
            await addUser(db, 'u-d', 'dani');
            await db.prepare(
                `INSERT INTO lobbies (id, host_user_id, title, mod_id, mod_combined_hash, status)
                 VALUES ('L-TEAM', 'u-a', 'team', 'wol', 'h', 'closed')`,
            ).bind().run();
            // Reported at 05:58 on the last day of Season 1, waiting for the other side.
            await db.prepare(
                `INSERT INTO matches (id, lobby_id, host_user_id, mod_id, mod_combined_hash,
                                      map_name, duration_seconds, started_at, ended_at, created_at,
                                      rated, unrated_reason, rating_mode, game_seed, game_host_time)
                 VALUES ('mt', 'L-TEAM', 'u-a', 'wol', 'h', 'map', 1500,
                         '2026-12-01 05:30:00', '2026-12-01 05:58:00', '2026-12-01 05:58:00',
                         0, 'awaiting_confirmation', 'team', 777, 888)`,
            ).bind().run();
            for (const [u, team, result] of [['u-a', 0, 1], ['u-b', 0, 1], ['u-c', 1, 0], ['u-d', 1, 0]] as
                Array<[string, number, number]>) {
                await db.prepare(
                    `INSERT INTO match_participants (match_id, user_id, team, result) VALUES ('mt', ?, ?, ?)`,
                ).bind(u, team, result).run();
            }
            // The opposing side's reading, agreeing, on the same game.
            await db.prepare(
                `INSERT INTO match_confirmations (lobby_id, user_id, result, game_seed, game_host_time)
                 VALUES ('L-TEAM', 'u-c', 0.0, 777, 888)`,
            ).bind().run();

            const teamBefore = await stateOf(db);
            const announced: Array<{ unratedReason?: string | null }> = [];
            await latePathsForTests.maybeRateAwaitingTeamMatch(
                fakeContext(db, announced), quietLog, 'L-TEAM', 'mt', Date.parse(nowIso));

            const row = await db.prepare(`SELECT rated, unrated_reason FROM matches WHERE id = 'mt'`)
                .bind().first<{ rated: number; unrated_reason: string | null }>();
            const results = await db.prepare(
                `SELECT user_id, result FROM match_participants WHERE match_id = 'mt' ORDER BY user_id`,
            ).bind().all<{ user_id: string; result: number }>();
            const team = await readRatings(db, 'team', 1);

            if (expectRated) {
                check(`${label}: rated on the team ladder of Season 1`,
                    row?.rated === 1 && row.unrated_reason === null && team.size === 4,
                    JSON.stringify(row));
            } else {
                check(
                    `${label}: stored season_closed, the result kept`,
                    row?.rated === 0 && row.unrated_reason === 'season_closed'
                    && (results.results ?? []).map((r) => r.result).join() === '1,1,0,0',
                    JSON.stringify([row, results.results]),
                );
                const after = await stateOf(db);
                const ratingsOnly = (s: string) => JSON.stringify(JSON.parse(s)[2]);
                check(`${label}: no rating anywhere moved`,
                    ratingsOnly(teamBefore) === ratingsOnly(after) && team.size === 0);
                check(`${label}: both sides are told it did not count, and why`,
                    announced.length === 1 && announced[0]!.unratedReason === 'season_closed',
                    JSON.stringify(announced));
            }
            db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }

    // ---- 17. the seasons migration copied Season 1 and nothing else -------------------
    {
        const dir = mkdtempSync(join(tmpdir(), 'wol-admin-test-'));
        const path = join(dir, 'lobby.db');
        // Build the database as it stood BEFORE seasons: every migration up to 0023.
        const pre = new Db(path);
        const all = (await import('node:fs')).readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort();
        const preDir = mkdtempSync(join(tmpdir(), 'wol-admin-mig-'));
        for (const f of all.filter((f) => f < '0024')) {
            (await import('node:fs')).copyFileSync(join('migrations', f), join(preDir, f));
        }
        pre.migrate(preDir);
        for (const [id, name] of [['u-a', 'ana'], ['u-b', 'beto'], ['u-z', 'zoe']]) {
            await pre.prepare(
                `INSERT INTO users (id, discord_id, discord_username, display_name) VALUES (?, ?, ?, ?)`,
            ).bind(id, `d-${id}`, name, name).run();
        }
        await pre.prepare(
            `INSERT INTO elo_ratings (user_id, mode, rating, rd, volatility, games_played)
             VALUES ('u-a', 'default', 1612.5, 210.25, 0.0599, 4),
                    ('u-b', 'team', 1444.0, 280.0, 0.06, 1),
                    ('u-z', 'default', 1500.0, 350.0, 0.06, 0)`,
        ).bind().run();
        pre.close();

        const db = new Db(path);
        db.migrate('migrations');
        const rows = await db.prepare(
            `SELECT user_id, mode, season, rating, rd, volatility, games_played FROM season_ratings
              ORDER BY user_id, mode`,
        ).bind().all<{ user_id: string; mode: string; season: number; rating: number; rd: number;
            volatility: number; games_played: number }>();
        check(
            'every rating with games became Season 1, exactly; the empty signup row did not',
            JSON.stringify((rows.results ?? []).map((r) => [r.user_id, r.mode, r.season, r.rating, r.rd, r.volatility, r.games_played]))
            === JSON.stringify([['u-a', 'default', 1, 1612.5, 210.25, 0.0599, 4], ['u-b', 'team', 1, 1444, 280, 0.06, 1]]),
            JSON.stringify(rows.results),
        );
        db.close();
        rmSync(dir, { recursive: true, force: true });
        rmSync(preDir, { recursive: true, force: true });
    }

    console.log(`\n${failures === 0 ? 'all good' : `${failures} failure(s)`}`);
    // The boundary itself, so a reader of this output knows which instant every test assumed.
    console.log(`(season 2 starts ${new Date(SEASON_2_START).toISOString()})`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
