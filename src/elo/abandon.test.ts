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
import { decideByAbandon, RECONNECT_GRACE_SECONDS } from './abandon';

const NOW = Date.parse('2026-08-24T18:30:00Z');
const STARTED = Date.parse('2026-08-24T18:10:00Z');   // 20 minutes in
const LONG_GONE = NOW - (RECONNECT_GRACE_SECONDS + 30) * 1000;

/** A 20-minute competitive 1v1 that 'beto' walked out of ten minutes ago. */
function ok(over: Partial<Parameters<typeof decideByAbandon>[0]> = {}) {
    return {
        participantIds: ['ana', 'beto'],
        abandons: [{ userId: 'beto', disconnectedAtMs: LONG_GONE }],
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

// --- the refusals ----------------------------------------------------------------

test('a socket gone for less than the reconnect grace is not a departure', () => {
    // The launcher reconnects on its own with backoff up to 30 s. Counting this would
    // turn a tunnel or a router hiccup into a forfeit.
    const justDropped = NOW - (RECONNECT_GRACE_SECONDS - 10) * 1000;
    const d = decideByAbandon(ok({ abandons: [{ userId: 'beto', disconnectedAtMs: justDropped }] }));
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
        abandons: [{ userId: 'beto', disconnectedAtMs: started + 280 * 1000 }],
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
        abandons: [{ userId: 'beto', disconnectedAtMs: started + 360 * 1000 }],
    }));

    assert.equal(d.loserId, 'beto');
    assert.equal(d.winnerId, 'ana');
});

test('both players gone is a draw, not a win for whoever dropped second', () => {
    // The usual cause is the host's connection dying and taking the room with it.
    const d = decideByAbandon(ok({
        abandons: [
            { userId: 'beto', disconnectedAtMs: LONG_GONE },
            { userId: 'ana', disconnectedAtMs: LONG_GONE },
        ],
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
        ok({ abandons: [{ userId: 'beto', disconnectedAtMs: NOW - 10 * 1000 }] }),
        ok({ startedAtMs: NOW - 60 * 1000 }),
    ]) {
        const d = decideByAbandon(bad);
        assert.equal(d.winnerId, null);
        assert.ok(d.reason.length > 0, 'a refusal must say why');
    }
});
