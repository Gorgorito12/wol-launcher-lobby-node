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
import { GAME_EXIT_INSERT_SQL, GAME_EXIT_EVIDENCE_SQL } from './LobbyRoom';

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

test('a match that has just ENDED still accepts the frame — the guest\'s game outlives the host\'s', () => {
    // AoE3 hands the guest the victory screen after the host's window is gone, so his frame
    // routinely arrives after `game_ended` put the room back to 'open'. Dropping it threw
    // away the one row that keeps HIM out of a forfeit. The window is bounded and keyed on
    // `ended_at`, which migration 0021 introduced precisely so `started_at` could survive.
    assert.match(SQL, /status = 'open'/);
    assert.match(SQL, /started_at IS NOT NULL/);
    assert.match(SQL, /ended_at >= datetime\('now', '-10 minutes'\)/);
    // And never for a room that is merely idle: 'open' alone is not enough.
    assert.doesNotMatch(SQL, /status = 'open'\s*\)/);
});

test('the evidence frame only ever UPDATES the row game_exited wrote — never inserts', () => {
    // Evidence about a game the server never saw close is not evidence of anything, and an
    // insert here would be a second door into the table with none of the first one's guard.
    assert.match(GAME_EXIT_EVIDENCE_SQL, /^\s*UPDATE lobby_game_exits/);
    assert.doesNotMatch(GAME_EXIT_EVIDENCE_SQL, /INSERT/);
    assert.match(GAME_EXIT_EVIDENCE_SQL, /WHERE lobby_id = \? AND user_id = \?/);
    // Seven placeholders: the five evidence columns, then the key.
    assert.equal(GAME_EXIT_EVIDENCE_SQL.match(/\?/g)?.length, 7);
    // And the timestamp is never touched: the verdict's clock is the first frame's.
    assert.doesNotMatch(GAME_EXIT_EVIDENCE_SQL, /exited_at/);
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
