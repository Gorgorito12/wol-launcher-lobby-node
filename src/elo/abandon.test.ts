/**
 * When walking out of a competitive match decides it. Run: `npm test`.
 *
 * <b>The refusals are the whole test file.</b> This is the only rule in the project that
 * moves rating from an absence of evidence, so what needs pinning is not that it fires —
 * it is every case where it must NOT. A false positive here takes ~160 points off somebody
 * whose power went out, with nothing on screen to explain it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideByAbandon, RECONNECT_GRACE_SECONDS, type AbandonRecord } from './abandon';

const NOW = Date.parse('2026-08-24T18:30:00Z');
const STARTED = Date.parse('2026-08-24T18:10:00Z');   // 20 minutes in
const LONG_GONE = NOW - (RECONNECT_GRACE_SECONDS + 30) * 1000;

/** A socket that dropped — what `lobby_abandons` records. */
function socket(userId: string, atMs: number, hasOutcome = false): AbandonRecord {
    return { userId, disconnectedAtMs: atMs, source: 'socket', hasOutcome };
}

/** A game that closed — what `lobby_game_exits` records. */
function gameExit(userId: string, atMs: number, hasOutcome = false): AbandonRecord {
    return { userId, disconnectedAtMs: atMs, source: 'game', hasOutcome };
}

/** A 20-minute competitive 1v1 that 'beto' walked out of ten minutes ago. */
function ok(over: Partial<Parameters<typeof decideByAbandon>[0]> = {}) {
    return {
        participantIds: ['ana', 'beto'],
        abandons: [socket('beto', LONG_GONE)],
        startedAtMs: STARTED,
        nowMs: NOW,
        abandonAfterSeconds: 300,
        reportHasRecording: true,
        pairDecidedRecently: false,
        ...over,
    };
}

test('one player walks out of a long game and the other is credited', () => {
    const d = decideByAbandon(ok());
    assert.equal(d.loserId, 'beto');
    assert.equal(d.winnerId, 'ana');
});

// --- the game-exit source --------------------------------------------------------
//
// The dodge this closes: the losing player closes Age of Empires III without closing the
// launcher. His socket stays up, so `lobby_abandons` never sees him, and his own engine
// writes no recording — a terminated process writes nothing. Every clause below is about
// telling that apart from the two innocent things that look identical from here.

test('THE DODGE — closing the game mid-match forfeits it', () => {
    const d = decideByAbandon(ok({ abandons: [gameExit('beto', STARTED + 600 * 1000)] }));
    assert.equal(d.loserId, 'beto');
    assert.equal(d.winnerId, 'ana');
});

test('a game closed after a real ending is not a walkout', () => {
    // The winner shuts his game the moment the match finishes, which drops him off here in
    // exactly the same way as a rage-quit. `hasOutcome` is the only thing separating the
    // two, and it is derived on the server from a stored reading with a fingerprint —
    // never from anything the client said, or this is the exploit arriving through its fix.
    const d = decideByAbandon(ok({
        abandons: [gameExit('beto', STARTED + 600 * 1000, true)],
    }));
    assert.equal(d.winnerId, null);
    assert.match(d.reason, /already finished/);
});

test('a closed game does not wait out the reconnect grace', () => {
    // The grace belongs to the SOCKET: the launcher reconnects on its own, so a dropped
    // connection has to be given time to come back. A closed game has nothing to come back
    // to — AoE3 has no rejoin — so waiting would only delay a verdict that cannot change.
    const justClosed = NOW - 5 * 1000;
    const d = decideByAbandon(ok({
        abandons: [gameExit('beto', justClosed)],
        startedAtMs: justClosed - 600 * 1000,
    }));
    assert.equal(d.loserId, 'beto');
});

test('closing the game inside the first five minutes is still too early', () => {
    // The threshold is about the match, not about the source. Same protection a dropped
    // socket gets, and the same refusal text.
    const started = NOW - 900 * 1000;
    const d = decideByAbandon(ok({
        startedAtMs: started,
        abandons: [gameExit('beto', started + 280 * 1000)],
    }));
    assert.equal(d.winnerId, null);
    assert.match(d.reason, /280s into the match/);
});

test('both games closing is a draw — a crash takes down two, not one', () => {
    const d = decideByAbandon(ok({
        abandons: [
            gameExit('beto', STARTED + 600 * 1000),
            gameExit('ana', STARTED + 601 * 1000),
        ],
    }));
    assert.equal(d.winnerId, null);
    assert.match(d.reason, /both/);
});

test('the game a player closed outranks the launcher he closed afterwards', () => {
    // He alt-F4s at 4:00 (too early to forfeit) and shuts the launcher at 12:00. The two
    // rows say different things, and the GAME is when the match actually ended for him —
    // so a socket that dropped later must not be able to turn it into a forfeit.
    const started = NOW - 900 * 1000;
    const d = decideByAbandon(ok({
        startedAtMs: started,
        abandons: [
            socket('beto', started + 720 * 1000),
            gameExit('beto', started + 240 * 1000),
        ],
    }));
    assert.equal(d.winnerId, null);
    assert.match(d.reason, /240s into the match/);
});

// --- the refusals ----------------------------------------------------------------

test('a socket gone for less than the reconnect grace is not a departure', () => {
    // The launcher reconnects on its own with backoff up to 30 s. Counting this would
    // turn a tunnel or a router hiccup into a forfeit.
    const justDropped = NOW - (RECONNECT_GRACE_SECONDS - 10) * 1000;
    const d = decideByAbandon(ok({ abandons: [socket('beto', justDropped)] }));
    assert.equal(d.winnerId, null);
});

test('leaving before the threshold decides nothing', () => {
    // Two minutes in, with the threshold at five: almost certainly wrong settings
    // rather than a dodge.
    const d = decideByAbandon(ok({ startedAtMs: NOW - 240 * 1000 }));
    assert.equal(d.winnerId, null);
});

test('a walkout inside the first five minutes is not rescued by a long match', () => {
    // THE REGRESSION, from a real incident. A player left at 4:40; the host kept his game
    // open and reported at fifteen minutes. The check measured `now - started` — the
    // REPORT, not the walkout — so it read fifteen minutes, forfeited him, and took 176
    // points. He would have been forfeited leaving at thirty seconds just the same, and
    // the create-room dialog he never saw promised the opposite.
    const started = NOW - 900 * 1000;
    const d = decideByAbandon(ok({
        startedAtMs: started,
        abandons: [socket('beto', started + 280 * 1000)],
    }));

    assert.equal(d.winnerId, null);
    assert.equal(d.loserId, null);
    // And it must say WHICH limit refused it: "the game only ran 900s" would be a lie
    // twice over — the game ran fine, and it is not the game being measured.
    assert.match(d.reason, /280s into the match/);
});

test('a walkout past the threshold still decides, promptly', () => {
    // The other side of the same change: six minutes in, reported two minutes later. This
    // is the dodge the rule exists for, and it must not have become harder to catch.
    const started = NOW - 480 * 1000;
    const d = decideByAbandon(ok({
        startedAtMs: started,
        abandons: [socket('beto', started + 360 * 1000)],
    }));

    assert.equal(d.loserId, 'beto');
    assert.equal(d.winnerId, 'ana');
});

test('both players gone is a draw, not a win for whoever dropped second', () => {
    // The usual cause is the host's connection dying and taking the room with it.
    const d = decideByAbandon(ok({
        abandons: [socket('beto', LONG_GONE), socket('ana', LONG_GONE)],
    }));
    assert.equal(d.winnerId, null);
});

test('nobody abandoned means nobody is credited', () => {
    assert.equal(decideByAbandon(ok({ abandons: [] })).winnerId, null);
});

test('a report with no recording cannot decide anything', () => {
    // Otherwise farming is: open a room, wait out the timer, alt-F4, repeat — never
    // actually playing. Requiring a recording puts the match under the anti-duplicate index.
    assert.equal(decideByAbandon(ok({ reportHasRecording: false })).winnerId, null);
});

test('the same pair cannot keep deciding matches this way', () => {
    assert.equal(decideByAbandon(ok({ pairDecidedRecently: true })).winnerId, null);
});

test('a room that never recorded when it started decides nothing', () => {
    assert.equal(decideByAbandon(ok({ startedAtMs: null })).winnerId, null);
});

test('a team game is refused — one leaver says nothing about who won', () => {
    const d = decideByAbandon(ok({ participantIds: ['ana', 'beto', 'caro', 'dani'] }));
    assert.equal(d.winnerId, null);
});

test('every refusal names its cause', () => {
    // A bare null in a log is not diagnosable, and this is the rule people will dispute.
    for (const bad of [
        ok({ abandons: [] }),
        ok({ reportHasRecording: false }),
        ok({ startedAtMs: null }),
        ok({ pairDecidedRecently: true }),
        ok({ abandons: [socket('beto', NOW - 10 * 1000)] }),
        ok({ startedAtMs: NOW - 60 * 1000 }),
        ok({ abandons: [gameExit('beto', STARTED + 600 * 1000, true)] }),
        ok({ abandons: [gameExit('beto', STARTED + 60 * 1000)] }),
    ]) {
        const d = decideByAbandon(bad);
        assert.equal(d.winnerId, null);
        assert.ok(d.reason.length > 0, 'a refusal must say why');
    }
});
