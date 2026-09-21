/**
 * The "one active lobby" guard, and the ban it used to be. Run: `npm test`.
 *
 * As in `ladder.test.ts`, the SQL is verified against a real database on deploy (see
 * DEPLOY.md) — there is no database harness here. What is pinned is the DECISION the query
 * encodes, so a later edit cannot quietly restore the old behaviour while the tests stay
 * green.
 *
 * The bug it exists for: the guard read
 *
 *     SELECT lobby_id FROM lobby_members WHERE user_id = ? AND lobby_id != ? LIMIT 1
 *
 * with no join to `lobbies` and no status filter. One row that outlived its lobby — a
 * `/leave` that never landed, a server restart — refused that player EVERY room, for ever,
 * and he could not clear it himself because joining was exactly what was refused. It
 * surfaced as a launcher dialog with no button but OK, and only `player:unstick` undid it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ALREADY_IN_LOBBY_SQL } from './rest';
import { Errors } from '../lib/errors';

const squash = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

test('THE ONE THAT MATTERS: the guard only counts lobbies that are still alive', () => {
    const sql = squash(ALREADY_IN_LOBBY_SQL);

    // It must reach `lobbies` at all — the old version never did.
    assert.ok(sql.includes('join lobbies'), 'the guard must join lobbies to see their status');
    assert.ok(sql.includes('l.status'), 'the guard must filter on lobby status');

    // And the statuses it accepts are the live ones, the same set the presence panel uses.
    for (const alive of ['open', 'locked', 'in_game']) {
        assert.ok(sql.includes(`'${alive}'`), `a ${alive} lobby must still block a join`);
    }

    // A closed lobby must NOT appear in the accepted set: that is the whole fix.
    assert.ok(!sql.includes("'closed'"), 'a closed lobby must never block a join');
});

test('the guard is still per-user and still ignores the room being joined', () => {
    const sql = squash(ALREADY_IN_LOBBY_SQL);
    assert.ok(sql.includes('m.user_id = ?'), 'it must be scoped to one player');
    // Without this a re-join of the room you are already in would refuse itself.
    assert.ok(sql.includes('m.lobby_id != ?'), 'the target room must be excluded');
});

test('it hands back the blocking lobby id, so a client can offer to leave it', () => {
    assert.ok(squash(ALREADY_IN_LOBBY_SQL).startsWith('select m.lobby_id'));

    const err = Errors.AlreadyInLobby({ lobby_id: 'abc123' });
    assert.equal(err.status, 409);
    assert.equal(err.code, 'already_in_lobby');
    assert.deepEqual(err.details, { lobby_id: 'abc123' });
});

test('an older caller that passes no details still gets the plain refusal', () => {
    const err = Errors.AlreadyInLobby();
    assert.equal(err.code, 'already_in_lobby');
    assert.equal(err.details, undefined);
});
