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
         canUpgradeFromConfirmation, matchShape, teamEvidenceMet,
         MIN_DURATION_SECONDS } from './ratability';

const RANKED = ['wol'];

/** A clean, ranked, decided, COMPETITIVE 1v1 — the only shape that scores. */
function ok(over: Partial<Parameters<typeof ratabilityReason>[0]> = {}) {
    const startedAt = '2026-08-24T18:00:00Z';
    return {
        modId: 'wol',
        rankedModIds: RANKED,
        participants: [{ result: 1 }, { result: 0 }],
        hasLobby: true,
        roomIsCompetitive: true,
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

test('a room that was not created competitive never scores', () => {
    assert.equal(ratabilityReason(ok({ roomIsCompetitive: false })), 'not_competitive');
});

// THE ONE THAT MATTERS. `null` means there was no room to ask, which is a different and
// more useful complaint than "it was not competitive" — and answering `not_competitive`
// there would also be a lie. Only an explicit false refuses.
test('a report with no room still says so, rather than blaming competitiveness', () => {
    assert.equal(
        ratabilityReason(ok({ roomIsCompetitive: null, hasLobby: false })),
        'no_lobby',
    );
});

test('an unranked mod outranks competitiveness — it is what you would have to change first', () => {
    assert.equal(
        ratabilityReason(ok({ modId: 'improvement-mod', roomIsCompetitive: false })),
        'mod_not_ranked',
    );
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

// ---------------------------------------------------------------------------
// Deciding a match after it was stored
// ---------------------------------------------------------------------------
//
// The REFUSALS are the point here even more than above, because one of them is the
// only thing standing between "the other player can rescue a match nobody could read"
// and "anyone can claim points from a player who reported honestly". The server never
// reads the recording — `result` is a number the client sends — so there is no
// verification to fall back on if this rule is wrong.

/** A late reading that SHOULD be accepted: the confirmer conceding their own defeat. */
function upgrade(over: Partial<Parameters<typeof canUpgradeFromConfirmation>[0]> = {}) {
    return {
        storedReason: 'no_decided_result' as string | null,
        storedSeed: null as number | null,
        storedHostTime: null as number | null,
        confirmResult: 0,
        confirmSeed: 3524 as number | null,
        confirmHostTime: 1507369 as number | null,
        confirmerInRoster: true,
        fingerprintAlreadyUsed: false,
        ...over,
    };
}

test('a player conceding their own defeat decides the match', () => {
    // The real case: the host found no recording at all, so the row has no fingerprint,
    // and the guest's own recording says he lost. Nobody lies to lose.
    const d = canUpgradeFromConfirmation(upgrade());
    assert.equal(d.ok, true);
    // With nothing stored, the confirmer's fingerprint is adopted — which also gives the
    // match the anti-duplicate protection a recording-less report could never have.
    assert.equal(d.adoptFingerprint, true);
});

test('a claimed VICTORY is refused when nothing corroborates it', () => {
    // THE anti-abuse test. If this ever goes green the wrong way, any player can take
    // points from an opponent who reported honestly, and no verification exists to catch
    // it. A win has to be backed by the fingerprint the reporter already stored.
    const d = canUpgradeFromConfirmation(upgrade({ confirmResult: 1 }));
    assert.equal(d.ok, false);
});

test('a claimed victory is accepted when the stored fingerprint matches', () => {
    const d = canUpgradeFromConfirmation(upgrade({
        confirmResult: 1,
        storedSeed: 3524,
        storedHostTime: 1507369,
    }));
    assert.equal(d.ok, true);
    // Nothing to adopt: the row already had it.
    assert.equal(d.adoptFingerprint, false);
});

test('two readings of DIFFERENT games never decide anything', () => {
    // Both sides have a fingerprint and they disagree, so one of them is reading somebody
    // else's recording. True even for a conceded defeat.
    assert.equal(canUpgradeFromConfirmation(upgrade({
        storedSeed: 111, storedHostTime: 222, confirmSeed: 333, confirmHostTime: 444,
    })).ok, false);
});

test('a match that already scored can never be re-decided', () => {
    // null means it was rated (or predates the column). Either way: not this rule's
    // business, and re-deciding it would move rating points a second time.
    assert.equal(canUpgradeFromConfirmation(upgrade({ storedReason: null })).ok, false);
});

test('a refusal for a reason no recording can change is left alone', () => {
    // A team game stays a team game however well anyone read it; same for an unranked mod
    // and a duplicate. Only "nobody won" is a question a recording can answer.
    for (const reason of ['not_1v1', 'mod_not_ranked', 'duplicate_recording',
                          'participants_not_in_lobby', 'implausible_timing', 'no_lobby']) {
        assert.equal(canUpgradeFromConfirmation(upgrade({ storedReason: reason })).ok, false, reason);
    }
});

test('a reading that names no winner decides nothing', () => {
    assert.equal(canUpgradeFromConfirmation(upgrade({ confirmResult: 0.5 })).ok, false);
});

test('somebody outside the frozen roster cannot decide a match', () => {
    // The same check the report itself passes: whoever decides a match has to have been in
    // it when it started.
    assert.equal(canUpgradeFromConfirmation(upgrade({ confirmerInRoster: false })).ok, false);
});

test('a recording that already decided another match cannot decide this one too', () => {
    assert.equal(canUpgradeFromConfirmation(upgrade({ fingerprintAlreadyUsed: true })).ok, false);
});

test('every refusal names its cause', () => {
    // A bare false is undiagnosable in a log, and this path runs where nobody is watching.
    for (const bad of [
        upgrade({ storedReason: null }),
        upgrade({ confirmResult: 0.5 }),
        upgrade({ confirmerInRoster: false }),
        upgrade({ confirmResult: 1 }),
        upgrade({ fingerprintAlreadyUsed: true }),
    ]) {
        const d = canUpgradeFromConfirmation(bad);
        assert.equal(d.ok, false);
        assert.ok(d.reason.length > 0);
    }
});

// ---------------------------------------------------------------------------
// The shape of a rateable match
// ---------------------------------------------------------------------------
//
// This replaced a bare `participants.length !== 2`. The refusals are what matter: a
// shape that reaches Glicko when nothing can read its winner would rate an invention.

/** Two sides of `perSide`, alternating, the way a report arrives. */
function sides(perSide: number) {
    const out: { result: number; team: number }[] = [];
    for (let i = 0; i < perSide; i++) out.push({ result: 1, team: 0 });
    for (let i = 0; i < perSide; i++) out.push({ result: 0, team: 1 });
    return out;
}

test('a 1v1 is the default ladder, teams or no teams', () => {
    assert.equal(matchShape([{ team: 0 }, { team: 0 }]), 'default');
    assert.equal(matchShape([{}, {}]), 'default');
    // Even nonsense sides: with two players there is exactly one pairing either way.
    assert.equal(matchShape([{ team: 3 }, { team: 7 }]), 'default');
});

test('two equal sides of 2 or 3 are the team ladder', () => {
    assert.equal(matchShape(sides(2)), 'team');
    assert.equal(matchShape(sides(3)), 'team');
});

test('a shape whose winner cannot be read is refused', () => {
    // A free-for-all: four players, four sides. One named loser says nothing about
    // the other three, which is the whole reason the old rule existed.
    assert.equal(matchShape([{ team: 0 }, { team: 1 }, { team: 2 }, { team: 3 }]), null);
    // Uneven sides — a 1v3 in a room that promised 2v2.
    assert.equal(matchShape([{ team: 0 }, { team: 1 }, { team: 1 }, { team: 1 }]), null);
    // Four players with no sides at all: every pre-team report carries team 0, and
    // collapsing to one side must NOT be read as a team game.
    assert.equal(matchShape([{}, {}, {}, {}]), null);
    // Sizes nothing has measured a recording for.
    assert.equal(matchShape(sides(4)), null);
    assert.equal(matchShape([{ team: 0 }, { team: 1 }, { team: 1 }]), null);
});

test('a team match reaches the evidence rule instead of not_1v1', () => {
    // The point of the change: a well-formed 2v2 is no longer refused for its shape.
    // Whether it RATES is then decided by teamEvidenceMet, which lives elsewhere.
    assert.equal(ratabilityReason(ok({ participants: sides(2) })), null);
    assert.equal(ratabilityReason(ok({ participants: sides(3) })), null);
});

test('a free-for-all is still not_1v1', () => {
    assert.equal(
        ratabilityReason(ok({
            participants: [
                { result: 1, team: 0 }, { result: 0, team: 1 },
                { result: 0, team: 2 }, { result: 0, team: 3 },
            ],
        })),
        'not_1v1',
    );
});

// ---------------------------------------------------------------------------
// One reading from EACH side
// ---------------------------------------------------------------------------

const TEAMS = new Map([['a1', 0], ['a2', 0], ['b1', 1], ['b2', 1]]);

function evidence(over: Partial<Parameters<typeof teamEvidenceMet>[0]> = {}) {
    return {
        teams: TEAMS,
        reporterTeam: 0,
        confirmations: [{ userId: 'b1', agreement: 'agree', sameGame: 'true' }],
        ...over,
    };
}

test('one agreeing reading from the other side is enough', () => {
    assert.equal(teamEvidenceMet(evidence()), true);
});

test('readings from the reporter own side corroborate nothing', () => {
    // THE case this rule exists for. Two teammates saying the same thing is one claim
    // twice; a whole winning team saying it is still one claim.
    assert.equal(teamEvidenceMet(evidence({
        confirmations: [
            { userId: 'a1', agreement: 'agree', sameGame: 'true' },
            { userId: 'a2', agreement: 'agree', sameGame: 'true' },
        ],
    })), false);
});

test('a reading that does not agree, or is of another game, is not evidence', () => {
    for (const c of [
        { userId: 'b1', agreement: 'disagree', sameGame: 'true' },
        { userId: 'b1', agreement: 'inconclusive', sameGame: 'true' },
        { userId: 'b1', agreement: 'not_reported', sameGame: 'true' },
        { userId: 'b1', agreement: null, sameGame: 'true' },
        { userId: 'b1', agreement: 'agree', sameGame: 'false' },
        // 'unknown' means one of the two had no seed to compare. Accepting it would let
        // two readings of DIFFERENT games corroborate each other by coincidence.
        { userId: 'b1', agreement: 'agree', sameGame: 'unknown' },
        { userId: 'b1', agreement: 'agree', sameGame: null },
    ]) {
        assert.equal(teamEvidenceMet(evidence({ confirmations: [c] })), false);
    }
});

test('a reading from somebody who was not in the match is not evidence', () => {
    assert.equal(teamEvidenceMet(evidence({
        confirmations: [{ userId: 'stranger', agreement: 'agree', sameGame: 'true' }],
    })), false);
});

test('no confirmations, and an unknown reporter side, are both refusals', () => {
    assert.equal(teamEvidenceMet(evidence({ confirmations: [] })), false);
    // The reporter is not among the participants — nothing can be "the other side".
    assert.equal(teamEvidenceMet(evidence({ reporterTeam: null })), false);
});

test('one good reading among bad ones still counts', () => {
    assert.equal(teamEvidenceMet(evidence({
        confirmations: [
            { userId: 'a1', agreement: 'agree', sameGame: 'true' },
            { userId: 'b1', agreement: 'inconclusive', sameGame: 'true' },
            { userId: 'b2', agreement: 'agree', sameGame: 'true' },
        ],
    })), true);
});
