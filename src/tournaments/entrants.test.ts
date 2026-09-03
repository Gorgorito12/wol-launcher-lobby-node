/**
 * Who may enter, in what order, and who moves up. Run: `npm test`.
 *
 * The REFUSALS are the point, as everywhere else in this project. The one that matters
 * most is `already_entered`: without it the same player sits on two teams in one bracket,
 * and the day those two meet there is no honest way to run the match — the recording
 * would name him on both sides.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    rosterSizeFor, teamSourceAllowed, validateRoster,
    conservativeRating, seedByRating, seedByExplicitOrder,
    promoteFromWaitlist, entryStatusFor, occupiesTournament, playsInBracket,
    DEFAULT_RATING, DEFAULT_RD,
    type SeedableEntrant, type WaitlistCandidate,
} from './entrants';

// ---------------------------------------------------------------- shape

test('roster sizes follow the format, and stop at three', () => {
    assert.equal(rosterSizeFor('1v1'), 1);
    assert.equal(rosterSizeFor('2v2'), 2);
    assert.equal(rosterSizeFor('3v3'), 3);
});

test('a 1v1 is solo-only and a team format is never solo', () => {
    assert.equal(teamSourceAllowed('1v1', 'solo'), true);
    assert.equal(teamSourceAllowed('1v1', 'registered'), false);
    assert.equal(teamSourceAllowed('2v2', 'solo'), false);
    for (const s of ['registered', 'adhoc', 'draft'] as const) {
        assert.equal(teamSourceAllowed('3v3', s), true, s);
    }
});

// ---------------------------------------------------------------- rosters

const noneEntered = new Set<string>();

test('a correctly sized roster of distinct free players is accepted', () => {
    assert.equal(validateRoster({ format: '1v1', memberIds: ['a'], alreadyEntered: noneEntered }), null);
    assert.equal(validateRoster({ format: '2v2', memberIds: ['a', 'b'], alreadyEntered: noneEntered }), null);
    assert.equal(validateRoster({ format: '3v3', memberIds: ['a', 'b', 'c'], alreadyEntered: noneEntered }), null);
});

test('a roster of the wrong size is refused in both directions', () => {
    assert.equal(validateRoster({ format: '2v2', memberIds: ['a'], alreadyEntered: noneEntered }), 'wrong_size');
    assert.equal(validateRoster({ format: '2v2', memberIds: ['a', 'b', 'c'], alreadyEntered: noneEntered }), 'wrong_size');
    assert.equal(validateRoster({ format: '1v1', memberIds: [], alreadyEntered: noneEntered }), 'wrong_size');
});

test('the same person cannot be listed twice in one roster', () => {
    assert.equal(
        validateRoster({ format: '2v2', memberIds: ['a', 'a'], alreadyEntered: noneEntered }),
        'duplicate_member');
});

test('THE ONE THAT MATTERS: somebody already in this tournament cannot join a second entrant', () => {
    assert.equal(
        validateRoster({ format: '2v2', memberIds: ['a', 'b'], alreadyEntered: new Set(['b']) }),
        'already_entered');
});

test('a banned player is refused before the already-entered check even applies', () => {
    assert.equal(
        validateRoster({
            format: '2v2', memberIds: ['a', 'b'],
            alreadyEntered: noneEntered, ineligible: new Set(['a']),
        }),
        'member_not_eligible');
});

test('withdrawing frees your players — that is what the caller passes in', () => {
    // The caller builds `alreadyEntered` from entrants that still occupy the tournament,
    // so a withdrawn one simply is not in the set and its players can re-register.
    assert.equal(occupiesTournament('withdrawn'), false);
    assert.equal(occupiesTournament('rejected'), false);
    assert.equal(occupiesTournament('disqualified'), false);
    for (const s of ['pending', 'confirmed', 'waitlist'] as const) {
        assert.equal(occupiesTournament(s), true, s);
    }
});

test('only a confirmed entrant gets a bracket slot', () => {
    assert.equal(playsInBracket('confirmed'), true);
    for (const s of ['pending', 'waitlist', 'rejected', 'withdrawn', 'disqualified'] as const) {
        assert.equal(playsInBracket(s), false, s);
    }
});

// ---------------------------------------------------------------- seeding

test('an unrated player is worth the bottom of the list, not the middle', () => {
    assert.equal(conservativeRating(undefined), DEFAULT_RATING - 2 * DEFAULT_RD);
    assert.equal(conservativeRating({ rating: 1500, rd: 350 }), 800);
    // A settled average player outranks an unplayed one, which is the whole point.
    assert.ok(conservativeRating({ rating: 1500, rd: 60 }) > conservativeRating(undefined));
});

test('a big deviation cannot buy a top seed', () => {
    // 1900 with a huge RD is less trustworthy than 1500 with a small one.
    assert.ok(conservativeRating({ rating: 1500, rd: 50 }) > conservativeRating({ rating: 1900, rd: 340 }));
});

const solo = (id: string, at = '2026-01-01 00:00:00'): SeedableEntrant =>
    ({ entrantId: id, memberIds: [id], registeredAt: at });

test('solo entrants seed strongest first', () => {
    const ratings = new Map([
        ['a', { rating: 1400, rd: 60 }],
        ['b', { rating: 1800, rd: 60 }],
        ['c', { rating: 1600, rd: 60 }],
    ]);
    assert.deepEqual(
        seedByRating([solo('a'), solo('b'), solo('c')], ratings),
        [{ entrantId: 'b', seed: 1 }, { entrantId: 'c', seed: 2 }, { entrantId: 'a', seed: 3 }]);
});

test('a team is seeded on the MEAN of its members, so one star cannot carry two novices', () => {
    const ratings = new Map([
        ['star', { rating: 2100, rd: 50 }],
        ['new1', { rating: 1500, rd: 350 }],
        ['new2', { rating: 1500, rd: 350 }],
        ['solid1', { rating: 1600, rd: 60 }],
        ['solid2', { rating: 1600, rd: 60 }],
        ['solid3', { rating: 1600, rd: 60 }],
    ]);
    const carried = { entrantId: 'carried', memberIds: ['star', 'new1', 'new2'], registeredAt: '2026-01-01 00:00:00' };
    const steady = { entrantId: 'steady', memberIds: ['solid1', 'solid2', 'solid3'], registeredAt: '2026-01-01 00:00:00' };
    const seeds = seedByRating([carried, steady], ratings);
    assert.equal(seeds[0].entrantId, 'steady', 'three settled players outrank a star with two unknowns');
});

test('ties break on registration time, then on id, so seeding is deterministic', () => {
    const ratings = new Map([
        ['a', { rating: 1500, rd: 60 }],
        ['b', { rating: 1500, rd: 60 }],
    ]);
    const first = seedByRating(
        [solo('b', '2026-01-02 00:00:00'), solo('a', '2026-01-01 00:00:00')], ratings);
    assert.deepEqual(first, [{ entrantId: 'a', seed: 1 }, { entrantId: 'b', seed: 2 }]);

    // Identical timestamps too: the id is the last resort and never Array.sort stability.
    const same = seedByRating([solo('z'), solo('y')], ratings);
    assert.deepEqual(same.map((s) => s.entrantId), ['y', 'z']);
});

test('an explicit order seeds exactly as typed', () => {
    const es = [solo('a'), solo('b'), solo('c')];
    const r = seedByExplicitOrder(es, ['c', 'a', 'b']);
    assert.equal(r.reason, undefined);
    assert.deepEqual(r.seeds, [
        { entrantId: 'c', seed: 1 }, { entrantId: 'a', seed: 2 }, { entrantId: 'b', seed: 3 }]);
});

test('a partial or malformed explicit order is refused rather than completed by guesswork', () => {
    const es = [solo('a'), solo('b'), solo('c')];
    assert.equal(seedByExplicitOrder(es, ['a', 'b']).reason, 'incomplete');
    assert.equal(seedByExplicitOrder(es, ['a', 'b', 'zzz']).reason, 'unknown_entrant');
    assert.equal(seedByExplicitOrder(es, ['a', 'a', 'b']).reason, 'duplicate_entrant');
    assert.deepEqual(seedByExplicitOrder(es, ['a', 'b']).seeds, [], 'a refusal seeds nothing');
});

// ---------------------------------------------------------------- capacity

const wl = (id: string, at: string, status: WaitlistCandidate['status'] = 'waitlist'): WaitlistCandidate =>
    ({ entrantId: id, status, registeredAt: at });

test('the waitlist promotes in the order people asked', () => {
    const cs = [
        wl('third', '2026-01-03 00:00:00'),
        wl('first', '2026-01-01 00:00:00'),
        wl('second', '2026-01-02 00:00:00'),
    ];
    assert.deepEqual(promoteFromWaitlist(cs, 1), ['first']);
    assert.deepEqual(promoteFromWaitlist(cs, 2), ['first', 'second']);
    assert.deepEqual(promoteFromWaitlist(cs, 99), ['first', 'second', 'third']);
});

test('only people actually waiting are promoted, and no slots means nobody', () => {
    const cs = [
        wl('confirmed-already', '2026-01-01 00:00:00', 'confirmed'),
        wl('gone', '2026-01-01 00:00:00', 'withdrawn'),
        wl('waiting', '2026-01-02 00:00:00'),
    ];
    assert.deepEqual(promoteFromWaitlist(cs, 5), ['waiting']);
    assert.deepEqual(promoteFromWaitlist(cs, 0), []);
    assert.deepEqual(promoteFromWaitlist(cs, -1), []);
});

test('open registration confirms while there is room and waitlists after', () => {
    assert.equal(entryStatusFor('open', true), 'confirmed');
    assert.equal(entryStatusFor('open', false), 'waitlist');
});

test('approval mode ignores capacity at registration time', () => {
    // Both, because the seat is only claimed when the owner accepts. Checking capacity
    // here as well would refuse applications a tournament could still take.
    assert.equal(entryStatusFor('approval', true), 'pending');
    assert.equal(entryStatusFor('approval', false), 'pending');
});
