/**
 * What a reported game means for its bracket slot. Run: `npm test`.
 *
 * The REFUSALS are the point, as in `bracket.test.ts`: a slot that advances when it should not
 * is a tournament with the wrong team in the next round, and nobody can tell afterwards whether
 * the tree was wrong or the game was. The first test is the bug this module exists for — a team
 * bracket that moved on the host's report alone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideReport, entrantOfLineup, type ReportVerdictInput } from './reportVerdict';

const A = { id: 'eA', members: ['a1', 'a2'] };
const B = { id: 'eB', members: ['b1', 'b2'] };

/** A clean 2v2: side A won, side B lost. */
function twoVsTwo(over: Partial<ReportVerdictInput> = {}): ReportVerdictInput {
    return {
        format: '2v2',
        entrant1: A,
        entrant2: B,
        participants: [
            { user_id: 'a1', result: 1 }, { user_id: 'a2', result: 1 },
            { user_id: 'b1', result: 0 }, { user_id: 'b2', result: 0 },
        ],
        unratedReason: null,
        corroborated: false,
        ...over,
    };
}

test('THE ONE THAT MATTERS: a team result the other side has not confirmed waits', () => {
    const v = decideReport(twoVsTwo({ unratedReason: 'awaiting_confirmation' }));
    assert.deepEqual(v, { kind: 'wait', reason: 'awaiting_confirmation' });
});

test('a team match released by the other side (rated) advances the winning entrant', () => {
    const v = decideReport(twoVsTwo({ unratedReason: null }));
    assert.equal(v.kind, 'advance');
    if (v.kind === 'advance') {
        assert.equal(v.winnerEntrantId, 'eA');
        assert.equal(v.loserEntrantId, 'eB');
        assert.deepEqual(v.winners, ['a1', 'a2']);
    }
});

test('a team match played with other sides than the bracket\'s never advances, even corroborated', () => {
    for (const corroborated of [false, true]) {
        assert.deepEqual(
            decideReport(twoVsTwo({ unratedReason: 'teams_mismatch', corroborated })),
            { kind: 'never', reason: 'teams_mismatch' });
    }
});

test('a corroborated team result advances whatever else the ladder thought of it', () => {
    assert.equal(decideReport(twoVsTwo({ unratedReason: 'new_account_short' })).kind, 'advance');
    for (const reason of ['duplicate_recording', 'mod_not_ranked', 'implausible_timing']) {
        assert.equal(decideReport(twoVsTwo({ unratedReason: reason, corroborated: true })).kind, 'advance', reason);
        assert.deepEqual(decideReport(twoVsTwo({ unratedReason: reason, corroborated: false })),
            { kind: 'wait', reason: 'awaiting_confirmation' }, reason);
    }
});

test('a 1v1 advances on a decided result, rated or not, exactly as before', () => {
    const oneVsOne = (unratedReason: string | null): ReportVerdictInput => ({
        format: '1v1',
        entrant1: { id: 'e1', members: ['p1'] },
        entrant2: { id: 'e2', members: ['p2'] },
        participants: [{ user_id: 'p1', result: 0 }, { user_id: 'p2', result: 1 }],
        unratedReason,
        corroborated: false,
    });
    for (const reason of [null, 'duplicate_recording', 'awaiting_confirmation', 'not_competitive']) {
        const v = decideReport(oneVsOne(reason));
        assert.equal(v.kind, 'advance', String(reason));
        if (v.kind === 'advance') assert.equal(v.winnerEntrantId, 'e2');
    }
});

test('only full line-ups decide a slot: a 2v2 reported with three of the four players does not', () => {
    const v = decideReport(twoVsTwo({
        participants: [
            { user_id: 'a1', result: 1 }, { user_id: 'a2', result: 1 }, { user_id: 'b1', result: 0 },
        ],
    }));
    assert.deepEqual(v, { kind: 'ignore', reason: 'lineups_do_not_match' });
});

test('two players of a 2v2 playing a 1v1 between themselves do not decide the tie', () => {
    const v = decideReport(twoVsTwo({
        participants: [{ user_id: 'a1', result: 1 }, { user_id: 'b1', result: 0 }],
    }));
    assert.deepEqual(v, { kind: 'ignore', reason: 'lineups_do_not_match' });
});

test('sides that cross the entrants stop the slot', () => {
    const v = decideReport(twoVsTwo({
        participants: [
            { user_id: 'a1', result: 1 }, { user_id: 'b1', result: 1 },
            { user_id: 'a2', result: 0 }, { user_id: 'b2', result: 0 },
        ],
    }));
    assert.deepEqual(v, { kind: 'ignore', reason: 'lineups_do_not_match' });
});

test('a player from outside both line-ups stops the slot', () => {
    const v = decideReport(twoVsTwo({
        participants: [
            { user_id: 'a1', result: 1 }, { user_id: 'x9', result: 1 },
            { user_id: 'b1', result: 0 }, { user_id: 'b2', result: 0 },
        ],
    }));
    assert.deepEqual(v, { kind: 'ignore', reason: 'lineups_do_not_match' });
});

test('a 0.5 is unreadable, never a draw — the slot stays open', () => {
    const v = decideReport(twoVsTwo({
        participants: [
            { user_id: 'a1', result: 0.5 }, { user_id: 'a2', result: 0.5 },
            { user_id: 'b1', result: 0.5 }, { user_id: 'b2', result: 0.5 },
        ],
    }));
    assert.deepEqual(v, { kind: 'ignore', reason: 'undecided' });
});

test('an unmerged draft player (a roster of one) can never be a 2v2 line-up', () => {
    const solo = { id: 'eS', members: ['a1'] };
    assert.equal(entrantOfLineup(['a1'], solo, B, 2), null);
    assert.equal(entrantOfLineup(['a1', 'a2'], solo, B, 2), null);
});

test('a line-up listing one player twice is not a line-up', () => {
    assert.equal(entrantOfLineup(['a1', 'a1'], A, B, 2), null);
});
