/**
 * The rule that decides whose rating moves. Run: `npm test`.
 *
 * node:test, which ships with Node 20 — no new dependency, no harness. These cover
 * the pure decision only; the SQL behind the leaderboard is checked against a real
 * database on deploy (see DEPLOY.md), not here.
 *
 * The REFUSALS are the point. Getting `no_decided_result` wrong once already cost
 * every stored rating in the database: every match played without a recording was
 * fed to Glicko as a draw between everyone, silently, while the launcher told the
 * player on screen that it had counted towards nobody's rating.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ratabilityReason, timingIsPlausible, isDecided, compareReadings,
         MIN_DURATION_SECONDS } from './ratability';

const RANKED = ['wol'];

/** A clean, ranked, decided 1v1 — the only shape that scores. */
function ok(over: Partial<Parameters<typeof ratabilityReason>[0]> = {}) {
    const startedAt = '2026-08-24T18:00:00Z';
    return {
        modId: 'wol',
        rankedModIds: RANKED,
        participants: [{ result: 1 }, { result: 0 }],
        hasLobby: true,
        allParticipantsInLobby: true,
        startedAt,
        endedAt: '2026-08-24T18:20:00Z',
        durationSeconds: 1200,
        nowMs: Date.parse('2026-08-24T18:25:00Z'),
        ...over,
    };
}

test('a decided 1v1 on a ranked mod scores', () => {
    assert.equal(ratabilityReason(ok()), null);
});

test('a mod with no ladder never scores', () => {
    assert.equal(ratabilityReason(ok({ modId: 'improvement-mod' })), 'mod_not_ranked');
});

test('the mod id is matched case-insensitively', () => {
    assert.equal(ratabilityReason(ok({ modId: 'WoL' })), null);
});

test('a team game never scores, however decided it looks', () => {
    // Exactly two, not "someone won": the launcher can only read a winner out of a
    // 1v1 recording, so a three-player claim did not come from a launcher we wrote.
    assert.equal(
        ratabilityReason(ok({ participants: [{ result: 1 }, { result: 0 }, { result: 0 }] })),
        'not_1v1',
    );
});

test('nobody won means nobody scores', () => {
    assert.equal(
        ratabilityReason(ok({ participants: [{ result: 0.5 }, { result: 0.5 }] })),
        'no_decided_result',
    );
});

test('a report with no room cannot be checked, so it does not score', () => {
    assert.equal(ratabilityReason(ok({ hasLobby: false })), 'no_lobby');
});

test('a player who never joined the room does not score anyone', () => {
    assert.equal(
        ratabilityReason(ok({ allParticipantsInLobby: false })),
        'participants_not_in_lobby',
    );
});

test('a match too short to be a match does not score', () => {
    assert.equal(
        ratabilityReason(ok({
            endedAt: '2026-08-24T18:01:00Z',
            durationSeconds: 60,
        })),
        'implausible_timing',
    );
});

test('a duration that disagrees with the timestamps does not score', () => {
    // Twenty minutes of wall clock, four hours claimed.
    assert.equal(
        ratabilityReason(ok({ durationSeconds: 14400 })),
        'implausible_timing',
    );
});

test('a match reported from the future does not score', () => {
    assert.equal(
        ratabilityReason(ok({ nowMs: Date.parse('2026-08-24T17:00:00Z') })),
        'implausible_timing',
    );
});

test('a match older than the window does not score', () => {
    assert.equal(
        ratabilityReason(ok({ nowMs: Date.parse('2026-09-24T18:25:00Z') })),
        'implausible_timing',
    );
});

test('unparseable timestamps do not score', () => {
    assert.equal(ratabilityReason(ok({ startedAt: 'whenever' })), 'implausible_timing');
    assert.equal(ratabilityReason(ok({ endedAt: '' })), 'implausible_timing');
});

test('timingIsPlausible accepts the shortest match that counts', () => {
    const started = '2026-08-24T18:00:00Z';
    assert.equal(timingIsPlausible({
        ...ok(),
        startedAt: started,
        endedAt: '2026-08-24T18:03:00Z',
        durationSeconds: MIN_DURATION_SECONDS,
    }), true);
});

test('isDecided is a threshold, not an equality', () => {
    assert.equal(isDecided(1), true);
    assert.equal(isDecided(0), true);
    assert.equal(isDecided(0.5), false);
    // The same numbers the tally in /matches/elo and the launcher's Classify use.
    assert.equal(isDecided(0.9995), true);
    assert.equal(isDecided(0.0005), true);
});

// --- compareReadings: the host's report against the other player's own reading ---

test('two readings that name the same winner agree', () => {
    // The guest lost; the host reported them as having lost.
    assert.equal(compareReadings(0, 0), 'agree');
    assert.equal(compareReadings(1, 1), 'agree');
});

test('two readings that contradict each other disagree', () => {
    // This is the case worth a human looking at it: two honest recordings of one
    // match cannot say this, because the trailer names the slots absolutely.
    assert.equal(compareReadings(1, 0), 'disagree');
    assert.equal(compareReadings(0, 1), 'disagree');
});

test('an unread recording is inconclusive, NOT a disagreement', () => {
    // The important one. "Nobody could read it" and "the two of them contradict each
    // other" are different facts, and folding the first into the second would make
    // the evidence look like rampant conflict when what really happened is that
    // somebody's game was not recording.
    assert.equal(compareReadings(1, 0.5), 'inconclusive');
    assert.equal(compareReadings(0.5, 0), 'inconclusive');
    assert.equal(compareReadings(0.5, 0.5), 'inconclusive');
});
