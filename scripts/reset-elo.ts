/**
 * RETIRED — this script no longer resets anything, and running it changes nothing.
 *
 * It wiped every stored rating to start the ladder over. It did that once, for a good reason
 * (see "Why it existed" below), and then rating seasons made it obsolete AND dangerous:
 *
 *   * Obsolete: the ladder now restarts by itself every three months (src/elo/seasons.ts). A
 *     new season simply has no rating rows, and every player starts it from a soft reset of the
 *     last season they played. Nothing has to be deleted for that to happen.
 *   * Dangerous: ratings live in `season_ratings`, one row per (player, ladder, season), and an
 *     ENDED season's rows are its permanent record — the final places, the medals, what each
 *     player's profile lists. Deleting them would erase every season's history at once. The old
 *     table this script emptied, `elo_ratings`, is frozen since migration 0024 and nothing reads
 *     it any more.
 *
 * To correct ratings, use the operator commands, which replay the ladder from the season a
 * correction belongs to and leave every earlier season untouched:
 *
 *   tsx scripts/admin.ts match:void <id>          stop a match counting
 *   tsx scripts/admin.ts match:decide <id> ...    settle a match by hand
 *   tsx scripts/admin.ts elo:recompute            replay; run it alone to self-check
 *
 * Why it existed. Until the ratability rule landed, POST /matches fed EVERY reported match to
 * Glicko — including the ones where nobody won — so the ratings were built mostly out of matches
 * that never should have moved them. They were wiped and rebuilt from scratch. It was a SCRIPT
 * and not a migration deliberately: a migration is remembered in the `_migrations` table of the
 * database it ran against, so restoring a backup and starting the service would have re-run it
 * and deleted the ratings just restored.
 */
console.error('scripts/reset-elo.ts is retired and did nothing.');
console.error('Ratings restart by themselves every season; an ended season\'s ratings are its');
console.error('permanent record. To correct a rating use scripts/admin.ts (match:void,');
console.error('match:decide, elo:recompute) — see the comment at the top of this file.');
process.exit(1);
