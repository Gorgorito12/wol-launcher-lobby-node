/**
 * Build a throwaway database with a small rated history, for poking the HTTP endpoints by hand:
 *   npx tsx scripts/test-seed-elo.ts /tmp/elo.db
 *   DB_PATH=/tmp/elo.db JWT_SIGNING_KEY=dev npx tsx src/index.ts
 *   curl localhost:8080/stats/community
 *
 * Twelve 1v1s between three players (so one of them finishes placement), a 2v2, a tournament game
 * and a refunded ban. Never point it at a real database: it creates the file it is given.
 */
import { Db } from '../src/db';
import { rateStoredMatch } from '../src/elo/ladder';
import { recomputeLadder } from '../src/elo/replay';

const path = process.argv[2];
if (!path) {
    console.log('Usage: test-seed-elo.ts <new.db>');
    process.exit(1);
}

async function main(): Promise<void> {
    const db = new Db(path!);
    db.migrate('migrations');
    const users = [['u-a', 'Ana'], ['u-b', 'Beto'], ['u-c', 'Caro'], ['u-d', 'Dani']];
    for (const [id, name] of users) {
        await db.prepare(
            `INSERT INTO users (id, discord_id, discord_username, display_name, created_at)
             VALUES (?, ?, ?, ?, datetime('now', '-90 days'))`,
        ).bind(id, `d-${id}`, name!.toLowerCase(), name).run();
    }
    let n = 0;
    const play = async (winner: string, loser: string, daysAgo: number, tournament: string | null = null) => {
        const id = `m${++n}`;
        await db.prepare(
            `INSERT INTO matches (id, lobby_id, host_user_id, mod_id, mod_combined_hash, map_name,
                                  duration_seconds, started_at, ended_at, created_at, rated,
                                  rating_mode, tournament_match_id)
             VALUES (?, NULL, ?, 'wol', 'h', 'Texas', 1500, datetime('now', ?), datetime('now', ?),
                     datetime('now', ?), 1, 'default', ?)`,
        ).bind(id, winner, `-${daysAgo} days`, `-${daysAgo} days`, `-${daysAgo} days`, tournament).run();
        for (const [u, r] of [[winner, 1], [loser, 0]] as Array<[string, number]>) {
            await db.prepare(
                `INSERT INTO match_participants (match_id, user_id, team, result) VALUES (?, ?, 0, ?)`,
            ).bind(id, u, r).run();
        }
        await rateStoredMatch(db, id, 'default');
    };
    for (let i = 0; i < 8; i++) await play('u-a', 'u-b', 40 - i);
    await play('u-b', 'u-a', 30);
    await play('u-a', 'u-c', 20, null);
    await play('u-c', 'u-a', 10);
    await play('u-a', 'u-c', 2);
    // A 2v2.
    const tid = `m${++n}`;
    await db.prepare(
        `INSERT INTO matches (id, lobby_id, host_user_id, mod_id, mod_combined_hash, map_name,
                              duration_seconds, started_at, ended_at, created_at, rated, rating_mode)
         VALUES (?, NULL, 'u-a', 'wol', 'h', 'Andes', 1800, datetime('now','-1 days'),
                 datetime('now','-1 days'), datetime('now','-1 days'), 1, 'team')`,
    ).bind(tid).run();
    for (const [u, team, r] of [['u-a', 1, 1], ['u-b', 1, 1], ['u-c', 2, 0], ['u-d', 2, 0]] as Array<[string, number, number]>) {
        await db.prepare(
            `INSERT INTO match_participants (match_id, user_id, team, result) VALUES (?, ?, ?, ?)`,
        ).bind(tid, u, team, r).run();
    }
    await rateStoredMatch(db, tid, 'team');
    // Caro was cheating: Ana gets back what she lost to her.
    await db.prepare(`UPDATE users SET is_banned = 1 WHERE id = 'u-c'`).bind().run();
    await db.prepare(`INSERT INTO ban_refunds (id, banned_user_id, reason) VALUES ('R1', 'u-c', 'test')`).bind().run();
    await recomputeLadder(db);
    db.close();
    console.log(`Seeded ${path}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
