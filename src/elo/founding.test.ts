/**
 * When the readings on file may found a match nobody reported. Run: `npm test`.
 *
 * <b>The refusals are the whole test file</b>, as in abandon.test.ts: this rule creates a
 * rated match out of a confirmation the host never answered, so what needs pinning is every
 * case where it must NOT — above all a lone "I won".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideFounding, type FoundingReading } from './founding';
import { RECONNECT_GRACE_SECONDS, type AbandonRecord } from './abandon';

const NOW = Date.parse('2026-09-12T18:30:00Z');
const STARTED = Date.parse('2026-09-12T18:10:00Z');   // 20 minutes in
const LONG_GONE = NOW - (RECONNECT_GRACE_SECONDS + 30) * 1000;

function socket(userId: string, atMs: number): AbandonRecord {
    return { userId, disconnectedAtMs: atMs, source: 'socket', hasOutcome: false };
}
function gameExit(userId: string, atMs: number): AbandonRecord {
    return { userId, disconnectedAtMs: atMs, source: 'game', hasOutcome: false };
}
function reading(userId: string, result: number, hasFingerprint = true): FoundingReading {
    return { userId, result, hasFingerprint };
}

/** Founding was installed a week before this match — i.e. the ordinary case. */
const EPOCH = STARTED - 7 * 24 * 60 * 60 * 1000;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

/** 'ana' read her recording: she LOST. Nobody else said anything. */
function conceded(over: Partial<Parameters<typeof decideFounding>[0]> = {}) {
    return {
        participantIds: ['ana', 'beto'],
        readings: [reading('ana', 0)],
        walkouts: [],
        startedAtMs: STARTED,
        nowMs: NOW,
        abandonAfterSeconds: 300,
        hasReport: false,
        pairDecidedRecently: false,
        fingerprintAlreadyUsed: false,
        roomClosed: true,
        foundingEnabledFromMs: EPOCH,
        maxAgeMs: MAX_AGE,
        ...over,
    };
}

/** 'ana' read her recording: she WON — and beto's socket walked out ten minutes in. */
function claimed(over: Partial<Parameters<typeof decideFounding>[0]> = {}) {
    return conceded({
        readings: [reading('ana', 1)],
        walkouts: [socket('beto', STARTED + 600 * 1000)],
        ...over,
    });
}

// --- the two ways a match is founded ----------------------------------------------------

test('a conceded defeat founds and rates at once', () => {
    const d = decideFounding(conceded());
    assert.equal(d.founderId, 'ana');
    assert.equal(d.loserId, 'ana');
    assert.equal(d.winnerId, 'beto');
});

test('a victory claim with the opponent walked out past both thresholds founds', () => {
    const d = decideFounding(claimed());
    assert.equal(d.founderId, 'ana');
    assert.equal(d.winnerId, 'ana');
    assert.equal(d.loserId, 'beto');
});

// --- THE ONE THAT MATTERS ---------------------------------------------------------------

test('THE_ONE_THAT_MATTERS: a lone victory claim founds nothing', () => {
    // No walkout on file for the opponent. "I won" is the reading a liar would send, and on
    // its own it must be worth exactly nothing.
    const d = decideFounding(claimed({ walkouts: [] }));
    assert.equal(d.founderId, null);
    assert.match(d.reason, /did not/);
});

// --- what does NOT corroborate a victory claim ------------------------------------------

test('an opponent who closed his GAME is never corroboration', () => {
    // A closed game is not a walkout anywhere in this project: in a 1v1 both games end
    // together, so it says nothing about who won.
    const d = decideFounding(claimed({ walkouts: [gameExit('beto', STARTED + 600 * 1000)] }));
    assert.equal(d.founderId, null);
    assert.match(d.reason, /closed his game/);
});

test('a walkout inside the first five minutes does not corroborate', () => {
    const d = decideFounding(claimed({ walkouts: [socket('beto', STARTED + 280 * 1000)] }));
    assert.equal(d.founderId, null);
    assert.match(d.reason, /280s into the match/);
});

test('a walkout inside the reconnect grace does not corroborate while the room is open', () => {
    const justNow = NOW - (RECONNECT_GRACE_SECONDS - 10) * 1000;
    const d = decideFounding(claimed({ walkouts: [socket('beto', justNow)], roomClosed: false }));
    assert.equal(d.founderId, null);
    assert.match(d.reason, /reconnect grace/);
});

test('once the room is closed the reconnect grace is waived — nobody can say hello again', () => {
    const justNow = NOW - 5 * 1000;
    const d = decideFounding(claimed({ walkouts: [socket('beto', justNow)], roomClosed: true }));
    assert.equal(d.winnerId, 'ana');
});

test('the walkout that corroborates must be the OPPONENT\'s, not the claimant\'s own', () => {
    // ana's own socket dropping says nothing about beto.
    const d = decideFounding(claimed({ walkouts: [socket('ana', LONG_GONE)] }));
    assert.equal(d.founderId, null);
});

// --- readings that found nothing --------------------------------------------------------

test('a reading without a fingerprint founds nothing', () => {
    const d = decideFounding(conceded({ readings: [reading('ana', 0, false)] }));
    assert.equal(d.founderId, null);
    assert.match(d.reason, /fingerprinted/);
});

test('an undecided reading founds nothing', () => {
    const d = decideFounding(conceded({ readings: [reading('ana', 0.5)] }));
    assert.equal(d.founderId, null);
});

test('a reading from somebody who was not in the room founds nothing', () => {
    const d = decideFounding(conceded({ readings: [reading('carla', 0)] }));
    assert.equal(d.founderId, null);
});

test('two readings that contradict each other found nothing — two victories is the colluders\' shape', () => {
    const both = decideFounding(claimed({ readings: [reading('ana', 1), reading('beto', 1)] }));
    assert.equal(both.founderId, null);
    assert.match(both.reason, /contradict/);

    const neither = decideFounding(conceded({ readings: [reading('ana', 0), reading('beto', 0)] }));
    assert.equal(neither.founderId, null);
});

test('two readings that agree found on the conceded defeat, and need no walkout', () => {
    const d = decideFounding(conceded({ readings: [reading('ana', 0), reading('beto', 1)] }));
    assert.equal(d.founderId, 'ana');
    assert.equal(d.winnerId, 'beto');
});

// --- from here forward, and only from here forward --------------------------------------
//
// The backlog is the danger, not the trickle. Orphaned confirmations pile up for as long as
// hosts have been failing to report, and foundPendingForUser hangs off GET /matches/history —
// so without a floor the first person to open the History tab after the deploy would have had
// ten of their old rooms founded and rated in one go, having asked for nothing.

test('THE ONE THAT MATTERS: a room that started before founding existed founds nothing', () => {
    const d = decideFounding(conceded({ foundingEnabledFromMs: STARTED + 1 }));
    assert.equal(d.founderId, null);
    assert.match(d.reason, /before founding existed/);
});

test('a room that started after it does found', () => {
    assert.equal(decideFounding(conceded({ foundingEnabledFromMs: STARTED - 1 })).founderId, 'ana');
    // The boundary is inclusive: a room started in the same millisecond is not "before".
    assert.equal(decideFounding(conceded({ foundingEnabledFromMs: STARTED })).founderId, 'ana');
});

test('an eight-day-old match founds nothing, however well the evidence lines up', () => {
    // Same refusal the server already gives a REPORT this old (timingIsPlausible / MAX_AGE_MS).
    // If the host may not report it, the server has no business inventing it.
    const d = decideFounding(conceded({ nowMs: STARTED + 8 * 24 * 60 * 60 * 1000 }));
    assert.equal(d.founderId, null);
    assert.match(d.reason, /8 day\(s\) old/);
});

test('the age limit applies to a corroborated victory too, not only a conceded defeat', () => {
    const d = decideFounding(claimed({ nowMs: STARTED + 9 * 24 * 60 * 60 * 1000 }));
    assert.equal(d.founderId, null);
    assert.match(d.reason, /old, past the limit/);
});

test('a match inside the limit is unaffected', () => {
    assert.equal(decideFounding(conceded({ nowMs: STARTED + 6 * 24 * 60 * 60 * 1000 })).founderId, 'ana');
});

// --- the brakes shared with the abandonment rule ----------------------------------------

test('a report on file means nothing is founded — that is the host\'s account', () => {
    const d = decideFounding(conceded({ hasReport: true }));
    assert.equal(d.founderId, null);
    assert.match(d.reason, /report exists/);
});

test('a team room founds nothing', () => {
    const d = decideFounding(conceded({ participantIds: ['ana', 'beto', 'carla', 'dani'] }));
    assert.equal(d.founderId, null);
    assert.match(d.reason, /1v1/);
});

test('the same pair cannot have a match inferred twice in a day', () => {
    const d = decideFounding(conceded({ pairDecidedRecently: true }));
    assert.equal(d.founderId, null);
});

test('a recording that already decided another match founds nothing', () => {
    const d = decideFounding(conceded({ fingerprintAlreadyUsed: true }));
    assert.equal(d.founderId, null);
    assert.match(d.reason, /already decided/);
});

test('a room that never recorded when it started founds nothing', () => {
    const d = decideFounding(conceded({ startedAtMs: null }));
    assert.equal(d.founderId, null);
});

test('every refusal names its cause', () => {
    for (const input of [
        conceded({ hasReport: true }),
        conceded({ participantIds: ['a'] }),
        conceded({ readings: [] }),
        claimed({ walkouts: [] }),
        claimed({ walkouts: [gameExit('beto', STARTED + 600 * 1000)] }),
    ]) {
        const d = decideFounding(input);
        assert.equal(d.founderId, null);
        assert.ok(d.reason.length > 0);
    }
});
