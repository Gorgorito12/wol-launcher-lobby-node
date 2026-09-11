/**
 * The gate on the `game_exited` write. Run: `npm test`.
 *
 * <p>Same split as `confirmationCivs.test.ts`: there is no database harness here, so what is
 * pinned is the SQL's GUARD rather than the round trip, which is checked against a real
 * database on deploy (DEPLOY.md). The guard is the whole safety of this frame — it is the
 * only thing standing between "a client said its game closed" and a row that can later cost
 * somebody a rated loss.</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GAME_EXIT_INSERT_SQL } from './LobbyRoom';

const SQL = GAME_EXIT_INSERT_SQL;

test('THE ONE THAT MATTERS: the row is only ever written for a LIVE COMPETITIVE match', () => {
    // Both conditions live in the SELECT, so they are asked of the authoritative lobby row
    // rather than of anything the sender said or of in-memory state a restart would have
    // cleared. Drop either and a casual room, or a room sitting idle, starts collecting
    // evidence that decideByAbandon would later weigh against somebody.
    assert.match(SQL, /INSERT OR IGNORE INTO lobby_game_exits/);
    assert.match(SQL, /SELECT \?, \?, \? FROM lobbies/);
    assert.match(SQL, /WHERE id = \?/);
    assert.match(SQL, /status = 'in_game'/);
    assert.match(SQL, /competitive = 1/);
});

test('the FIRST exit is the one that counts', () => {
    // OR IGNORE, not OR REPLACE. Reopening the game and closing it again must not be able to
    // move the mark later into the match and out of forfeit range — which is precisely what
    // somebody who has just been told it counts as a loss would try.
    assert.match(SQL, /INSERT OR IGNORE/);
    assert.doesNotMatch(SQL, /INSERT OR REPLACE/);
});

test('exactly four placeholders, in the order the handler binds them', () => {
    // lobby, user, client_seconds — then the lobby again, for the WHERE. A miscount here
    // silently writes the wrong column or throws at runtime, and no test would see it.
    assert.equal(SQL.match(/\?/g)?.length, 4);
});

test('the server times the row itself', () => {
    // `exited_at` is never bound: it defaults to the server's own clock at INSERT. The
    // client's number goes into `client_seconds`, which no verdict reads. The client is what
    // an attacker controls, and this is a rule that moves rating.
    assert.doesNotMatch(SQL, /exited_at/);
    assert.match(SQL, /client_seconds/);
});
