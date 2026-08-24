/**
 * Wipe every stored rating and start the ladder over.
 * Run: `npx tsx scripts/reset-elo.ts` (stop the service first).
 *
 * Why this exists. Until the ratability rule landed, POST /matches fed EVERY
 * reported match to Glicko — including the ones where nobody won. The launcher
 * sends 0.5 for every player when it could not read a winner, and the backend
 * processed that as a draw between everyone: ratings drifted towards each other
 * and games_played counted games that the launcher was, on screen, calling
 * "it counted towards no one's rating". Since AoE3 does not record by default,
 * almost every stored match is one of those — so the ratings in the database
 * were built mostly out of matches that never should have moved them. There is
 * nothing to salvage; they start again.
 *
 * What is NOT touched: `matches` and `match_participants.result`. The history is
 * the record of what was played and who won, and it stays whole. Only the
 * inferred numbers go.
 *
 * A SCRIPT and not a migration, deliberately. A migration is remembered in the
 * _migrations table of the database it ran against — but your BACKUP predates
 * that row, so restoring the backup and starting the service would re-run the
 * migration and delete the ratings you just restored. That would make the
 * rollback destroy the thing it was for. A forgotten script leaves the ratings
 * wrong, which is recoverable; a migration here is not.
 */
import { Db } from '../src/db';
import { loadConfig } from '../src/env';

function main(): void {
    const cfg = loadConfig();
    const db = new Db(cfg.dbPath);
    const raw = db.raw();

    const before = {
        ratings: (raw.prepare('SELECT COUNT(*) AS n FROM elo_ratings').get() as { n: number }).n,
        stamped: (raw.prepare(
            'SELECT COUNT(*) AS n FROM match_participants WHERE rating_before IS NOT NULL',
        ).get() as { n: number }).n,
        matches: (raw.prepare('SELECT COUNT(*) AS n FROM matches').get() as { n: number }).n,
    };

    console.log(`Database : ${cfg.dbPath}`);
    console.log(`Before   : ${before.ratings} rating rows, ${before.stamped} stamped participants, ` +
                `${before.matches} matches (kept)`);

    if (before.ratings === 0 && before.stamped === 0) {
        console.log('Nothing to reset — already clean.');
        db.close();
        return;
    }

    // One transaction: a half-done reset would leave ratings that no longer
    // match the deltas recorded against them.
    const reset = raw.transaction(() => {
        raw.prepare('DELETE FROM elo_ratings').run();
        raw.prepare(
            'UPDATE match_participants SET rating_before = NULL, rating_after = NULL',
        ).run();
    });
    reset();

    const after = {
        ratings: (raw.prepare('SELECT COUNT(*) AS n FROM elo_ratings').get() as { n: number }).n,
        stamped: (raw.prepare(
            'SELECT COUNT(*) AS n FROM match_participants WHERE rating_before IS NOT NULL',
        ).get() as { n: number }).n,
        matches: (raw.prepare('SELECT COUNT(*) AS n FROM matches').get() as { n: number }).n,
    };

    console.log(`After    : ${after.ratings} rating rows, ${after.stamped} stamped participants, ` +
                `${after.matches} matches (kept)`);
    console.log('Done. Rows are recreated on the first rated match; until then every');
    console.log('player reads as the default 1500 / rd 350, which is what they now are.');

    db.close();
}

main();
