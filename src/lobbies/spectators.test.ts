import test from 'node:test';
import assert from 'node:assert/strict';

import {
    MAX_SPECTATOR_SLOTS,
    playingSeatsOf,
    resolveSpectatorSlots,
} from './create';

/**
 * Observer seats, and specifically the ways they could take something away from somebody.
 *
 * AoE3 has no engine-level spectator: an observer is a real player in a real map slot that the
 * map script leaves with no town centre, no settlers and no crates. So an observer costs a seat
 * out of `max_players`, and a competitive room's format is read off what is LEFT.
 *
 * The failure this exists to prevent is silent. A 2v2 with one observer is five seats; five
 * matched no competitive size, so the room was created casual, the game was played, and the
 * result did not score. Nobody was told.
 */

test('a room that asked for no observers is untouched — every room that exists today', () => {
    // THE ONE THAT MATTERS. Every room ever created, and every client that does not know
    // about this field, arrives here as undefined. If any of these moved by one, every
    // existing competitive room would resolve to a different format or to none.
    for (const seats of [2, 4, 6, 8]) {
        assert.equal(resolveSpectatorSlots(undefined, seats), 0);
        assert.equal(playingSeatsOf(seats, 0), seats);
    }
});

test('an observer seat comes off the top, leaving the format intact', () => {
    // 3 seats, one watching, is still a 1v1; 5 is still a 2v2; 7 is still a 3v3.
    assert.equal(playingSeatsOf(3, resolveSpectatorSlots(1, 3)), 2);
    assert.equal(playingSeatsOf(5, resolveSpectatorSlots(1, 5)), 4);
    assert.equal(playingSeatsOf(7, resolveSpectatorSlots(1, 7)), 6);
    assert.equal(playingSeatsOf(8, resolveSpectatorSlots(2, 8)), 6);
});

test('a room is never left with fewer than two people playing', () => {
    // The clamp that matters. Two seats and two observers would be a competitive room with
    // nobody in it — or a "1v1" whose only player wins by having no opponent.
    assert.equal(resolveSpectatorSlots(2, 2), 0);
    assert.equal(resolveSpectatorSlots(1, 2), 0);
    assert.equal(resolveSpectatorSlots(2, 3), 1);
    assert.equal(resolveSpectatorSlots(9, 4), 2);
});

test('the cap holds however many are asked for', () => {
    // Every observer costs a real map slot, and the map script reads team assignments off the
    // first six. An unbounded count would let a client build a "6v6" that is one player and
    // eleven watchers and have them placed as if they were playing.
    assert.equal(resolveSpectatorSlots(50, 8), MAX_SPECTATOR_SLOTS);
    assert.equal(resolveSpectatorSlots(Number.MAX_SAFE_INTEGER, 8), MAX_SPECTATOR_SLOTS);
});

test('nonsense is read as none, never as something to subtract', () => {
    // A negative would ADD seats, promoting a 1v1 room into a rated 2v2 that nobody agreed to
    // play. NaN and Infinity survive Math.max and Math.min unchanged, so they are refused by
    // type and finiteness before any arithmetic — the reason the check is ordered that way.
    for (const bad of [-1, -100, NaN, Infinity, -Infinity, null, undefined, '2', {}, []]) {
        const n = resolveSpectatorSlots(bad, 8);
        assert.equal(Number.isInteger(n), true, `${String(bad)} produced ${n}`);
        assert.equal(n >= 0 && n <= MAX_SPECTATOR_SLOTS, true, `${String(bad)} produced ${n}`);
    }
    assert.equal(resolveSpectatorSlots(-2, 8), 0);
    assert.equal(playingSeatsOf(2, -2), 2);
});

test('a fractional seat is not a seat', () => {
    assert.equal(resolveSpectatorSlots(1.9, 8), 1);
    assert.equal(resolveSpectatorSlots(0.9, 8), 0);
});
