/**
 * Harness for the operator commands — above all, for the rating replay they lean on — and for the
 * rating rules that only a real database can exercise: decay over time, anti-farm, refunds, the
 * new-account fence and placement.
 *
 * Run: `npx tsx scripts/test-admin.ts`
 *
 * <p><b>The test that matters is the first one.</b> `recomputeLadder` is what makes every
 * correction safe: `applyMatch` has no inverse, so "undo this match" is implemented as "replay
 * the ladder without it". That is only sound if a replay over UNCHANGED data reproduces the
 * ratings already in the database, exactly. If it does not, the replay is not faithful and no
 * correction command can be trusted — so that property is asserted before anything else, and
 * again with gaps of days between matches (the deviation decay) and with anti-farm in play.</p>
 *
 * <p>Not in `npm test`, which runs the pure unit tests. This one builds a real SQLite file, so it
 * belongs beside the other `scripts/test-*.ts` harnesses.</p>
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyBaseLogger } from 'fastify';
import { Db } from '../src/db';
import { DEFAULT_RATING, type RatingMode } from '../src/elo/glicko2';
import { applyRefund, effectiveRatings, rateStoredMatch } from '../src/elo/ladder';
import type { AppContext } from '../src/context';
import { LOBBY_LIST_SQL } from '../src/lobbies/rest';
import { MEMBER_HELLO_SQL } from '../src/lobbies/LobbyRoom';
import { latePathsForTests } from '../src/matches/rest';
import { ladderRanks, ladderSize } from '../src/stats/rest';
import { loadHighlightRows } from '../src/stats/highlights';
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

/** A user row. No rating row: a player gets one with his first rated match. */
async function addUser(db: Db, id: string, name: string): Promise<void> {
    await db.prepare(
        `INSERT INTO users (id, discord_id, discord_username, display_name) VALUES (?, ?, ?, ?)`,
    ).bind(id, `d-${id}`, name, name).run();
}

/**
 * Store a rated 1v1 at `at` and rate it the way the live path does: through rateStoredMatch, from
 * the stored rows, at report time.
 */
async function playRated(db: Db, id: string, winner: string, loser: string, at: string,
    tournamentMatchId: string | null = null): Promise<void> {
    await db.prepare(
        `INSERT INTO matches (id, lobby_id, host_user_id, mod_id, mod_combined_hash,
                              map_name, duration_seconds, started_at, ended_at, created_at,
                              rated, unrated_reason, tournament_match_id)
         VALUES (?, NULL, ?, 'wol', 'h', 'test_map', 900, ?, ?, ?, 1, NULL, ?)`,
    ).bind(id, winner, at, at, at, tournamentMatchId).run();

    for (const [u, r] of [[winner, 1.0], [loser, 0.0]] as Array<[string, number]>) {
        await db.prepare(
            `INSERT INTO match_participants (match_id, user_id, result) VALUES (?, ?, ?)`,
        ).bind(id, u, r).run();
    }

    await rateStoredMatch(db, id, 'default');
}

/**
 * Build a database that looks like one the live server produced: three users, three rated 1v1s,
 * and the ratings applied in REPORT order — which is what the live path does, and what the replay
 * has to reproduce.
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
        await read(`SELECT user_id, mode, rating, rd, volatility, games_played
                      FROM player_ratings ORDER BY user_id, mode`),
    ]);
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
        config: { rankedModIds: ['wol'], newAccountShortMatchSeconds: 600 },
        rooms: { get: () => undefined },
        globalChat: {
            announceMatchRated: (n: unknown) => { announced.push(n); },
            announceTournamentUpdate: () => {},
        },
    } as unknown as AppContext;
}

const quietLog = { info() {}, warn() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger;

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
        const eff = (await effectiveRatings(db, ['u-z'], 'default')).get('u-z');
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

    // ================================================================ the new rules

    // ---- 9. decay: days between matches, and the replay still reproduces them exactly ---
    {
        const { db, dir } = await seed();
        await playRated(db, 'g1', 'u-b', 'u-a', '2026-08-20 10:00:00');   // after 19 idle days
        await playRated(db, 'g2', 'u-c', 'u-b', '2026-09-30 22:00:00');   // after 40 more
        const live = await readRatings(db);
        await recomputeLadder(db);
        const replayed = await readRatings(db);
        const drift = identicalLadder(live, replayed);
        check('with idle gaps between matches, a replay reproduces the ladder to the bit', drift === null, drift ?? '');

        const atMatch = (await effectiveRatings(db, ['u-a'], 'default', Date.parse('2026-08-01T10:03:00Z'))).get('u-a')!;
        const later = (await effectiveRatings(db, ['u-a'], 'default', Date.parse('2026-12-01T10:03:00Z'))).get('u-a')!;
        check('a player who sits out is shown a larger deviation, never a different rating',
            later.rd > atMatch.rd && later.rating === atMatch.rating,
            `${atMatch.rd.toFixed(1)} -> ${later.rd.toFixed(1)}`);
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 10. anti-farm: stored per match, and the replay reproduces every factor ----------
    {
        const { db, dir } = await seed();
        for (let i = 0; i < 5; i++) {
            await playRated(db, `f${i}`, 'u-a', 'u-b', `2026-08-02 1${i}:00:00`);
        }
        const factors = async () => (await db.prepare(
            `SELECT elo_factor, farm_streak FROM matches WHERE id LIKE 'f%' ORDER BY id`,
        ).bind().all<{ elo_factor: number; farm_streak: number }>()).results ?? [];
        const live = await factors();
        // m1 already had a beat b on 08-01, so these are wins 2..6 of the streak.
        check('the factors of a streak against the same rival: 100, 90, 80, 70, 60',
            JSON.stringify(live.map((r) => r.elo_factor)) === JSON.stringify([1, 0.9, 0.8, 0.7, 0.6]),
            JSON.stringify(live));
        const stamps = await db.prepare(
            `SELECT rating_before, rating_after FROM match_participants WHERE match_id = 'f4' ORDER BY user_id`,
        ).bind().all<{ rating_before: number; rating_after: number }>();
        const [winner, loser] = stamps.results ?? [];
        check('both players are scaled: the loser loses less too',
            winner!.rating_after > winner!.rating_before && loser!.rating_after < loser!.rating_before);
        const ratingsBefore = await readRatings(db);
        await recomputeLadder(db);
        check('the replay stores the same factors', JSON.stringify(await factors()) === JSON.stringify(live));
        const drift = identicalLadder(ratingsBefore, await readRatings(db));
        check('and the same ladder', drift === null, drift ?? '');
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 11. a tournament game is never discounted and never part of the chain ------------
    {
        const { db, dir } = await seed();
        await playRated(db, 'f1', 'u-a', 'u-b', '2026-08-02 10:00:00');
        await playRated(db, 'f2', 'u-a', 'u-b', '2026-08-02 11:00:00', 'TM-1');
        await playRated(db, 'f3', 'u-a', 'u-b', '2026-08-02 12:00:00');
        const rows = (await db.prepare(
            `SELECT id, elo_factor, farm_streak FROM matches WHERE id IN ('f1','f2','f3') ORDER BY id`,
        ).bind().all<{ id: string; elo_factor: number; farm_streak: number | null }>()).results ?? [];
        check('the tournament game counts in full and is not in the chain',
            rows[1]!.elo_factor === 1 && rows[1]!.farm_streak === null, JSON.stringify(rows[1]));
        // m1 (the day before, under 24 h earlier) and f1 are wins 1 and 2; f3 is the 3rd — the
        // tournament game in between neither counted nor broke the chain.
        check('the next ordinary game continues the chain as if it were not there',
            rows[2]!.elo_factor === 0.9 && rows[2]!.farm_streak === 3, JSON.stringify(rows[2]));
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 12. ban refunds ----------------------------------------------------------------
    {
        const { db, dir } = await seed();
        // a beat b (m1) and a beat c (m3): b and c lost points to a. Ban a with a refund.
        const bBefore = (await readRatings(db)).get('u-b')!.rating;
        await db.prepare(`UPDATE users SET is_banned = 1 WHERE id = 'u-a'`).bind().run();
        await db.prepare(
            `INSERT INTO ban_refunds (id, banned_user_id, reason) VALUES ('R1', 'u-a', 'cheating')`,
        ).bind().run();
        const given = await applyRefund(db, 'R1');
        const b = given.find((g) => g.userId === 'u-b');
        const lostToA = await db.prepare(
            `SELECT rating_before - rating_after AS lost FROM match_participants WHERE match_id = 'm1' AND user_id = 'u-b'`,
        ).bind().first<{ lost: number }>();
        check('THE ONE THAT MATTERS: each opponent gets back exactly what he lost to the cheater',
            !!b && Math.abs(b.points - lostToA!.lost) < 1e-9 && given.every((g) => g.userId !== 'u-a'),
            JSON.stringify(given));
        check('the refund lands on the rating',
            Math.abs((await readRatings(db)).get('u-b')!.rating - (bBefore + b!.points)) < 1e-9);

        await db.prepare(`UPDATE rating_refunds SET seen_at = '2026-10-01 00:00:00' WHERE user_id = 'u-b'`).bind().run();
        const once = await readRatings(db);
        await recomputeLadder(db);
        const again = await readRatings(db);
        const drift = identicalLadder(once, again);
        check('a replay re-derives the refund and changes nothing', drift === null, drift ?? '');
        const seen = await db.prepare(`SELECT seen_at FROM rating_refunds WHERE user_id = 'u-b'`).bind()
            .first<{ seen_at: string | null }>();
        check('and keeps the player\'s "Got it"', seen?.seen_at === '2026-10-01 00:00:00');

        // Voiding m1 means b never lost to a: his refund disappears with the replay.
        await db.prepare(`UPDATE matches SET rated = 0, unrated_reason = 'voided_by_operator' WHERE id = 'm1'`).bind().run();
        await db.prepare(`UPDATE match_participants SET result = 0.5 WHERE match_id = 'm1'`).bind().run();
        await recomputeLadder(db);
        const left = await db.prepare(`SELECT COUNT(*) AS n FROM rating_refunds WHERE user_id = 'u-b'`).bind()
            .first<{ n: number }>();
        check('voiding the match it paid for removes the refund line', left?.n === 0);

        await db.prepare(`UPDATE ban_refunds SET revoked_at = datetime('now') WHERE id = 'R1'`).bind().run();
        await recomputeLadder(db);
        const none = await db.prepare(`SELECT COUNT(*) AS n FROM rating_refunds`).bind().first<{ n: number }>();
        check('a revoked refund leaves nothing behind', none?.n === 0);
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 13. the new-account fence in a late path ------------------------------------------
    {
        for (const [label, accountAge, sharedIp, expectRated] of [
            ['an established pair', "datetime('now', '-60 days')", true, true],
            ['a new account on the same network', "datetime('now', '-2 days')", true, false],
            ['a new account on another network', "datetime('now', '-2 days')", false, true],
        ] as Array<[string, string, boolean, boolean]>) {
            const { db, dir } = await seed();
            await addUser(db, 'u-d', 'dani');
            // The seeded players signed up "today", which would make them all new accounts.
            await db.prepare(`UPDATE users SET created_at = datetime('now', '-90 days')`).bind().run();
            await db.prepare(`UPDATE users SET created_at = ${accountAge} WHERE id = 'u-d'`).bind().run();
            await db.prepare(
                `INSERT INTO lobbies (id, host_user_id, title, mod_id, mod_combined_hash, status)
                 VALUES ('L-T', 'u-a', 'team', 'wol', 'h', 'closed')`,
            ).bind().run();
            await db.prepare(
                `INSERT INTO matches (id, lobby_id, host_user_id, mod_id, mod_combined_hash,
                                      map_name, duration_seconds, started_at, ended_at, created_at,
                                      rated, unrated_reason, rating_mode, game_seed, game_host_time)
                 VALUES ('mt', 'L-T', 'u-a', 'wol', 'h', 'map', 240,
                         datetime('now', '-10 minutes'), datetime('now', '-5 minutes'), datetime('now', '-5 minutes'),
                         0, 'awaiting_confirmation', 'team', 777, 888)`,
            ).bind().run();
            for (const [u, team, result] of [['u-a', 0, 1], ['u-b', 0, 1], ['u-c', 1, 0], ['u-d', 1, 0]] as
                Array<[string, number, number]>) {
                await db.prepare(
                    `INSERT INTO match_participants (match_id, user_id, team, result) VALUES ('mt', ?, ?, ?)`,
                ).bind(u, team, result).run();
            }
            await db.prepare(
                `INSERT INTO lobby_member_ips (lobby_id, user_id, ip_hash) VALUES ('L-T', 'u-a', 'HASH-A'), ('L-T', 'u-d', ?)`,
            ).bind(sharedIp ? 'HASH-A' : 'HASH-D').run();
            await db.prepare(
                `INSERT INTO match_confirmations (lobby_id, user_id, result, game_seed, game_host_time)
                 VALUES ('L-T', 'u-c', 0.0, 777, 888)`,
            ).bind().run();

            const announced: Array<{ unratedReason?: string | null }> = [];
            await latePathsForTests.maybeRateAwaitingTeamMatch(fakeContext(db, announced), quietLog, 'L-T', 'mt');
            const row = await db.prepare(`SELECT rated, unrated_reason FROM matches WHERE id = 'mt'`)
                .bind().first<{ rated: number; unrated_reason: string | null }>();
            const team = await readRatings(db, 'team');
            if (expectRated) {
                check(`${label}: rated`, row?.rated === 1 && team.size === 4, JSON.stringify(row));
            } else {
                check(`${label}: stored new_account_short, nobody rated, both sides told why`,
                    row?.rated === 0 && row.unrated_reason === 'new_account_short' && team.size === 0
                    && announced[0]?.unratedReason === 'new_account_short',
                    JSON.stringify([row, announced]));
            }
            db.close();
            rmSync(dir, { recursive: true, force: true });
        }
    }

    // ---- 14. placement: nobody is ranked before ten matches --------------------------------
    {
        const { db, dir } = await seed();
        const ctx = fakeContext(db, []);
        check('three matches each: nobody is ranked yet', await ladderSize(ctx, 'default') === 0);
        const ranks = await ladderRanks(ctx, ['u-a', 'u-b'], 'default');
        check('a player in placement reads 0 (no position)', ranks.get('u-a') === 0 && ranks.get('u-b') === 0);
        for (let i = 0; i < 9; i++) {
            await playRated(db, `p${i}`, i % 2 ? 'u-a' : 'u-c', i % 2 ? 'u-c' : 'u-a', `2026-08-0${(i % 8) + 2} 0${i}:00:00`);
        }
        const a = (await readRatings(db)).get('u-a')!;
        const size = await ladderSize(ctx, 'default');
        check('ten rated matches rank a player', a.games_played >= 10 && size >= 1,
            `games ${a.games_played}, ranked ${size}`);
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 15. the hello and the rooms list work on a real database --------------------------
    {
        const { db, dir } = await seed();
        await db.prepare(
            `INSERT INTO lobbies (id, host_user_id, title, mod_id, mod_combined_hash, status, max_players)
             VALUES ('L-OPEN', 'u-a', 'open', 'wol', 'h', 'open', 4)`,
        ).bind().run();
        await db.prepare(`INSERT INTO lobby_members (lobby_id, user_id, team) VALUES ('L-OPEN', 'u-a', 1)`).bind().run();
        const hello = await db.prepare(MEMBER_HELLO_SQL).bind('L-OPEN', 'u-a').all<{ team: number }>();
        check('the hello finds the member exactly once, with his team',
            (hello.results ?? []).length === 1 && hello.results[0]!.team === 1);
        const rooms = await db.prepare(LOBBY_LIST_SQL).bind().all();
        check('the rooms list runs', (rooms.results ?? []).length >= 1);
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 16. the monthly highlights read a real database ------------------------------------
    {
        const { db, dir } = await seed();
        const rows = await loadHighlightRows(fakeContext(db, []), Date.parse('2026-09-01T06:00:00Z'));
        check('every rated participation is read with its ladder ordinal',
            rows.length === 6 && rows.filter((r) => r.user_id === 'u-a').map((r) => r.ordinal).join() === '1,2',
            JSON.stringify(rows.map((r) => [r.user_id, r.ordinal])));
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }

    // ---- 17. migration 0025 copied Season 1 into player_ratings, and nothing else ----------
    {
        const dir = mkdtempSync(join(tmpdir(), 'wol-admin-test-'));
        const path = join(dir, 'lobby.db');
        const fs = await import('node:fs');
        const all = fs.readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort();
        const preDir = mkdtempSync(join(tmpdir(), 'wol-admin-mig-'));
        for (const f of all.filter((f) => f < '0025')) fs.copyFileSync(join('migrations', f), join(preDir, f));
        const pre = new Db(path);
        pre.migrate(preDir);
        for (const [id, name] of [['u-a', 'ana'], ['u-b', 'beto']]) {
            await pre.prepare(
                `INSERT INTO users (id, discord_id, discord_username, display_name) VALUES (?, ?, ?, ?)`,
            ).bind(id, `d-${id}`, name, name).run();
        }
        await pre.prepare(
            `INSERT INTO season_ratings (user_id, mode, season, rating, rd, volatility, games_played)
             VALUES ('u-a', 'default', 1, 1612.5, 210.25, 0.0599, 4),
                    ('u-b', 'team', 1, 1444.0, 280.0, 0.06, 1),
                    ('u-b', 'default', 2, 1490.0, 250.0, 0.06, 0)`,
        ).bind().run();
        pre.close();

        const db = new Db(path);
        db.migrate('migrations');
        const rows = await db.prepare(
            `SELECT user_id, mode, rating, rd, volatility, games_played FROM player_ratings ORDER BY user_id, mode`,
        ).bind().all<{ user_id: string; mode: string; rating: number; rd: number; volatility: number; games_played: number }>();
        check('Season 1 rows with games became the interim ladder; nothing else did',
            JSON.stringify((rows.results ?? []).map((r) => [r.user_id, r.mode, r.rating, r.rd, r.games_played]))
            === JSON.stringify([['u-a', 'default', 1612.5, 210.25, 4], ['u-b', 'team', 1444, 280, 1]]),
            JSON.stringify(rows.results));
        db.close();
        rmSync(dir, { recursive: true, force: true });
        rmSync(preDir, { recursive: true, force: true });
    }

    console.log(`\n${failures === 0 ? 'all good' : `${failures} failure(s)`}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
