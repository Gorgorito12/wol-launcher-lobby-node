/**
 * When a crash voids a match, and when the closing of a game counts as a crash at all.
 * Run: `npm test`.
 *
 * <b>The refusals are the whole test file.</b> A void that fires too readily is a dodge with
 * a new name — kill the process, keep the rating — so what is pinned is every case where a
 * closed game must NOT be read as a crash, and every case where a real crash must still
 * count as the loss it is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isNtstatusFailure, verifyCrash, normaliseRecordingOutcome } from './crashEvidence';
import { decideCrashVoid } from './crashVoid';

// --- crashEvidence: what counts as a crash --------------------------------------------

const ACCESS_VIOLATION = -1073741819;   // 0xC0000005 as .NET hands it back (signed)

test('a real crash: event seen, no ending, not stopped, failure exit code', () => {
    assert.equal(verifyCrash({
        exitCode: ACCESS_VIOLATION, recordingOutcome: 'absent', stoppedByUser: false, eventSeen: true,
    }), true);
});

test('THE ONE THAT MATTERS: a taskkill is not a crash — no event, exit code 1', () => {
    assert.equal(verifyCrash({
        exitCode: 1, recordingOutcome: 'absent', stoppedByUser: false, eventSeen: false,
    }), false);
    // Even if the exit code somehow read as a failure, no event means no crash.
    assert.equal(verifyCrash({
        exitCode: ACCESS_VIOLATION, recordingOutcome: 'absent', stoppedByUser: false, eventSeen: false,
    }), false);
});

test('an Alt-F4 is not a crash — exit 0 and the recording has its ending', () => {
    assert.equal(verifyCrash({
        exitCode: 0, recordingOutcome: 'present', stoppedByUser: false, eventSeen: false,
    }), false);
});

test('the Stop button is never a crash, whatever else is true', () => {
    assert.equal(verifyCrash({
        exitCode: ACCESS_VIOLATION, recordingOutcome: 'absent', stoppedByUser: true, eventSeen: true,
    }), false);
});

test('a crash with the ending written is not what ended the match', () => {
    // The game wrote its outcome and crashed afterwards — on the victory screen, say. The
    // match had already finished; the crash decides nothing about it.
    assert.equal(verifyCrash({
        exitCode: ACCESS_VIOLATION, recordingOutcome: 'present', stoppedByUser: false, eventSeen: true,
    }), false);
    assert.equal(verifyCrash({
        exitCode: ACCESS_VIOLATION, recordingOutcome: 'unknown', stoppedByUser: false, eventSeen: true,
    }), false);
});

test('an unknown exit code does not block a verified event — the elevated launch has no handle', () => {
    assert.equal(verifyCrash({
        exitCode: null, recordingOutcome: 'absent', stoppedByUser: false, eventSeen: true,
    }), true);
});

test('a normal exit code with an event is not a crash — the event was some other run', () => {
    assert.equal(verifyCrash({
        exitCode: 0, recordingOutcome: 'absent', stoppedByUser: false, eventSeen: true,
    }), false);
});

test('NTSTATUS failure is read unsigned, as .NET signs it', () => {
    assert.equal(isNtstatusFailure(ACCESS_VIOLATION), true);   // 0xC0000005
    assert.equal(isNtstatusFailure(0xC0000005), true);
    assert.equal(isNtstatusFailure(-1073741795), true);        // 0xC000001D
    assert.equal(isNtstatusFailure(0), false);
    assert.equal(isNtstatusFailure(1), false);
    assert.equal(isNtstatusFailure(-1), false);                // 0xFFFFFFFF: taskkill, not NTSTATUS
    assert.equal(isNtstatusFailure(0x40000000), false);        // informational
    assert.equal(isNtstatusFailure(Number.NaN), false);
});

test('only the three words are accepted for the recording outcome', () => {
    assert.equal(normaliseRecordingOutcome('present'), 'present');
    assert.equal(normaliseRecordingOutcome('absent'), 'absent');
    assert.equal(normaliseRecordingOutcome('unknown'), 'unknown');
    assert.equal(normaliseRecordingOutcome('ABSENT'), 'unknown');
    assert.equal(normaliseRecordingOutcome(1), 'unknown');
    assert.equal(normaliseRecordingOutcome(undefined), 'unknown');
});

// --- crashVoid: what a verified crash may do -------------------------------------------

function ok(over: Partial<Parameters<typeof decideCrashVoid>[0]> = {}) {
    return {
        participantIds: ['ana', 'beto'],
        loserId: 'beto',
        crashedIds: new Set(['beto']),
        priorVoidsForLoser: 0,
        perWindow: 1,
        isTournament: false,
        ...over,
    };
}

test('THE ONE THAT MATTERS: a verified crash voids and never flips — the crasher never gains', () => {
    const d = decideCrashVoid(ok());
    assert.equal(d.voidFor, 'beto');
    // There is no winnerId in the decision at all: a void has no winner to name.
    assert.ok(!('winnerId' in d));
});

test('the winner crashing changes nothing', () => {
    const d = decideCrashVoid(ok({ crashedIds: new Set(['ana']) }));
    assert.equal(d.voidFor, null);
    assert.match(d.reason, /did not crash/);
});

test('an unverified game exit voids nothing', () => {
    const d = decideCrashVoid(ok({ crashedIds: new Set() }));
    assert.equal(d.voidFor, null);
});

test('a second crash inside the window counts as a loss', () => {
    const d = decideCrashVoid(ok({ priorVoidsForLoser: 1 }));
    assert.equal(d.voidFor, null);
    assert.match(d.reason, /this one counts/);
    // And a bigger budget lets it through until it is spent.
    assert.equal(decideCrashVoid(ok({ priorVoidsForLoser: 1, perWindow: 2 })).voidFor, 'beto');
    assert.equal(decideCrashVoid(ok({ priorVoidsForLoser: 2, perWindow: 2 })).voidFor, null);
});

test('a tournament match is never voided', () => {
    const d = decideCrashVoid(ok({ isTournament: true }));
    assert.equal(d.voidFor, null);
    assert.match(d.reason, /tournament/);
});

test('a team room is never voided', () => {
    const d = decideCrashVoid(ok({ participantIds: ['ana', 'beto', 'carla', 'dani'] }));
    assert.equal(d.voidFor, null);
});

test('an undecided match has nothing to void', () => {
    const d = decideCrashVoid(ok({ loserId: null }));
    assert.equal(d.voidFor, null);
    assert.match(d.reason, /nobody lost/);
});

test('a loser who was not in the room voids nothing', () => {
    const d = decideCrashVoid(ok({ loserId: 'carla', crashedIds: new Set(['carla']) }));
    assert.equal(d.voidFor, null);
});

test('every refusal names its cause', () => {
    for (const input of [
        ok({ participantIds: ['a'] }),
        ok({ loserId: null }),
        ok({ crashedIds: new Set() }),
        ok({ isTournament: true }),
        ok({ priorVoidsForLoser: 5 }),
    ]) {
        const d = decideCrashVoid(input);
        assert.equal(d.voidFor, null);
        assert.ok(d.reason.length > 0);
    }
});
