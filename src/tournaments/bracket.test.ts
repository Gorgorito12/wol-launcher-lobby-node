/**
 * The bracket rules. Run: `npm test`.
 *
 * node:test, like every other suite here. The REFUSALS are the point, same as in
 * `ratability.test.ts`: a bracket that advances when it should not is a tournament with
 * the wrong winner, and nobody can tell after the fact whether the tree was wrong or the
 * game was.
 *
 * The two properties the seeding rests on — every first-round pair summing to `size + 1`,
 * and the top two seeds meeting only in the final — are asserted here rather than left as
 * a comment, because the bye placement is derived from the first one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    bracketSize, roundsFor, seedOrder, nextOf, playable,
    generateBracket, advance, disqualify, voidMatch,
    type BracketMatch, type SeededEntrant,
} from './bracket';

let seq = 0;
const mintId = () => `m${++seq}`;

function entrants(n: number): SeededEntrant[] {
    return Array.from({ length: n }, (_, i) => ({ entrantId: `e${i + 1}`, seed: i + 1 }));
}

/** Build a bracket for N entrants with deterministic ids. */
function build(n: number): BracketMatch[] {
    seq = 0;
    return generateBracket(entrants(n), mintId);
}

const at = (ms: BracketMatch[], round: number, position: number) =>
    ms.find((m) => m.round === round && m.position === position)!;

// ---------------------------------------------------------------- shape

test('the bracket is the next power of two, and never smaller than two', () => {
    assert.equal(bracketSize(2), 2);
    assert.equal(bracketSize(3), 4);
    assert.equal(bracketSize(5), 8);
    assert.equal(bracketSize(8), 8);
    assert.equal(bracketSize(13), 16);
    // A tournament of one is not a tournament; the floor keeps log2 honest.
    assert.equal(bracketSize(1), 2);
    assert.equal(bracketSize(0), 2);
});

test('round counts follow the size', () => {
    assert.equal(roundsFor(2), 1);
    assert.equal(roundsFor(5), 3);
    assert.equal(roundsFor(16), 4);
});

test('every first-round pair sums to size + 1 — this is what puts the byes on the top seeds', () => {
    for (const size of [2, 4, 8, 16, 32]) {
        const order = seedOrder(size);
        assert.equal(order.length, size, `seedOrder(${size}) length`);
        assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: size }, (_, i) => i + 1));
        for (let p = 0; p < size; p += 2) {
            assert.equal(order[p] + order[p + 1], size + 1, `pair at ${p} of size ${size}`);
        }
    }
});

test('the top two seeds cannot meet before the final', () => {
    for (const n of [8, 16]) {
        const ms = build(n);
        const rounds = roundsFor(n);
        const pathOf = (entrantId: string) => {
            let m = ms.find((x) => x.round === 1 && (x.entrant1Id === entrantId || x.entrant2Id === entrantId))!;
            const path = [m.id];
            while (m.nextMatchId) {
                m = ms.find((x) => x.id === m.nextMatchId)!;
                path.push(m.id);
            }
            return path;
        };
        const a = pathOf('e1');
        const b = pathOf('e2');
        const shared = a.filter((id) => b.includes(id));
        assert.equal(shared.length, 1, `${n}: seeds 1 and 2 share exactly one match`);
        assert.equal(ms.find((m) => m.id === shared[0])!.round, rounds, `${n}: and it is the final`);
    }
});

test('links point exactly one round ahead, and only the final has none', () => {
    const ms = build(13);
    const rounds = roundsFor(13);
    const byId = new Map(ms.map((m) => [m.id, m]));
    let finals = 0;
    for (const m of ms) {
        if (!m.nextMatchId) {
            finals++;
            assert.equal(m.round, rounds);
            assert.equal(m.nextSlot, null);
            continue;
        }
        const next = byId.get(m.nextMatchId)!;
        assert.equal(next.round, m.round + 1);
        assert.equal(next.position, m.position >> 1);
        assert.equal(m.nextSlot, (m.position & 1) + 1);
    }
    assert.equal(finals, 1, 'exactly one final');
});

test('nextOf agrees with the materialised links', () => {
    // Matches 0 and 1 both feed round-two position 0, into slots 1 and 2 respectively.
    assert.deepEqual(nextOf(1, 0, 3), { round: 2, position: 0, slot: 1 });
    assert.deepEqual(nextOf(1, 1, 3), { round: 2, position: 0, slot: 2 });
    assert.deepEqual(nextOf(1, 2, 3), { round: 2, position: 1, slot: 1 });
    assert.deepEqual(nextOf(1, 3, 3), { round: 2, position: 1, slot: 2 });
    assert.equal(nextOf(3, 0, 3), null, 'the final feeds nothing');
});

test('a full bracket has no byes and seats everyone exactly once', () => {
    const ms = build(8);
    const first = ms.filter((m) => m.round === 1);
    assert.equal(first.length, 4);
    assert.equal(first.filter((m) => m.status === 'bye').length, 0);
    const seated = first.flatMap((m) => [m.entrant1Id, m.entrant2Id]).filter(Boolean).sort();
    assert.deepEqual(seated, ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8']);
});

test('byes go to the top seeds, are exactly size minus N, and never pair up', () => {
    for (const n of [3, 5, 6, 7, 13]) {
        const ms = build(n);
        const first = ms.filter((m) => m.round === 1);
        const byes = first.filter((m) => m.status === 'bye');
        assert.equal(byes.length, bracketSize(n) - n, `${n}: bye count`);

        // Nobody sits out twice, and no match is empty on both sides.
        for (const m of first) {
            const present = [m.entrant1Id, m.entrant2Id].filter(Boolean);
            assert.notEqual(present.length, 0, `${n}: a first-round match with nobody in it`);
        }

        // The entrants who got one are the highest seeds, i.e. the lowest numbers.
        const gotBye = byes.map((m) => m.winnerEntrantId!).sort();
        const expected = Array.from({ length: bracketSize(n) - n }, (_, i) => `e${i + 1}`).sort();
        assert.deepEqual(gotBye, expected, `${n}: byes went to the top seeds`);
    }
});

test('a bye is resolved AT GENERATION and already seats its winner in round two', () => {
    const ms = build(5);
    const bye = ms.find((m) => m.round === 1 && m.status === 'bye')!;
    assert.equal(bye.outcome, 'bye');
    assert.equal(bye.winnerEntrantId, 'e1');
    const next = ms.find((m) => m.id === bye.nextMatchId)!;
    const seated = bye.nextSlot === 1 ? next.entrant1Id : next.entrant2Id;
    assert.equal(seated, 'e1', 'round two already knows who is waiting');
});

test('a round-two match fed by two byes is immediately playable', () => {
    // 5 entrants: seeds 2 and 3 both get byes and land in the same round-two match.
    const ms = build(5);
    const ready = ms.filter((m) => m.round === 2 && playable(m));
    assert.equal(ready.length, 1);
    assert.deepEqual([ready[0].entrant1Id, ready[0].entrant2Id].sort(), ['e2', 'e3']);
});

test('generation refuses malformed seeding rather than producing a wrong bracket', () => {
    assert.throws(() => generateBracket([{ entrantId: 'e1', seed: 1 }], mintId), /at least two/);
    assert.throws(() => generateBracket(
        [{ entrantId: 'a', seed: 1 }, { entrantId: 'b', seed: 1 }], mintId), /duplicate seed/);
    assert.throws(() => generateBracket(
        [{ entrantId: 'a', seed: 1 }, { entrantId: 'b', seed: 3 }], mintId), /seed 2 is missing/);
});

// ---------------------------------------------------------------- advancing

test('a win moves the winner into the correct slot of the next round', () => {
    const ms = build(8);
    const m0 = at(ms, 1, 0);
    const r = advance(ms, m0.id, m0.entrant1Id!, 'played');
    assert.equal(r.ok, true);
    assert.equal(r.tournamentDone, false);

    const nextUpdate = r.updates.find((u) => u.id === m0.nextMatchId)!;
    assert.equal(nextUpdate.entrant1Id, m0.entrant1Id, 'position 0 feeds slot 1');

    const own = r.updates.find((u) => u.id === m0.id)!;
    assert.equal(own.status, 'done');
    assert.equal(own.outcome, 'played');
});

test('position 1 feeds slot 2, and the pair makes the next match ready', () => {
    let ms = build(8);
    ms = applied(ms, advance(ms, at(ms, 1, 0).id, at(ms, 1, 0).entrant1Id!, 'played').updates);
    const m1 = at(ms, 1, 1);
    const r = advance(ms, m1.id, m1.entrant2Id!, 'played');
    const next = r.updates.find((u) => u.id === m1.nextMatchId)!;
    assert.equal(next.entrant2Id, m1.entrant2Id);
    assert.deepEqual(r.newlyReady, [m1.nextMatchId], 'both slots full, so it is playable now');
});

test('deciding the final ends the tournament and names the champion', () => {
    let ms = build(2);
    const final = at(ms, 1, 0);
    const r = advance(ms, final.id, 'e1', 'played');
    assert.equal(r.tournamentDone, true);
    assert.equal(r.championEntrantId, 'e1');
    assert.equal(r.newlyReady.length, 0);
});

test('the same match cannot be decided twice', () => {
    let ms = build(8);
    const m0 = at(ms, 1, 0);
    ms = applied(ms, advance(ms, m0.id, m0.entrant1Id!, 'played').updates);
    const again = advance(ms, m0.id, m0.entrant2Id!, 'played');
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'already_decided');
    assert.deepEqual(again.updates, []);
});

test('a bye cannot be won, and an unknown match is refused', () => {
    const ms = build(5);
    const bye = ms.find((m) => m.status === 'bye')!;
    assert.equal(advance(ms, bye.id, 'e1', 'played').reason, 'is_bye');
    assert.equal(advance(ms, 'nope', 'e1', 'played').reason, 'match_not_found');
});

test('somebody who is not in the match cannot win it', () => {
    const ms = build(8);
    const m0 = at(ms, 1, 0);
    const r = advance(ms, m0.id, 'e7', 'played');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'winner_not_in_match');
});

// ---------------------------------------------------------------- disqualification

test('a disqualification hands over every match where the opponent is already known', () => {
    const ms = build(8);
    const m0 = at(ms, 1, 0);
    const victim = m0.entrant1Id!;
    const beneficiary = m0.entrant2Id!;
    const updates = disqualify(ms, victim);
    const own = updates.find((u) => u.id === m0.id)!;
    assert.equal(own.status, 'done');
    assert.equal(own.outcome, 'dq');
    assert.equal(own.winnerEntrantId, beneficiary);
});

test('a disqualification with no opponent yet waits, then resolves when one arrives', () => {
    // e1 has a bye in a 5-bracket, so its round-two opponent is unknown until 4v5 is played.
    let ms = build(5);
    const r2 = ms.find((m) => m.round === 2 && !playable(m))!;
    const waiting = r2.entrant1Id ?? r2.entrant2Id!;

    const first = disqualify(ms, waiting);
    assert.equal(first.find((u) => u.id === r2.id), undefined,
        'nothing to award while the other slot is empty');
    ms = applied(ms, first);

    // Now play the match that feeds the empty slot; the arrival should lose by walkover.
    const feeder = ms.find((m) => m.nextMatchId === r2.id && m.status === 'pending')!;
    const arriving = feeder.entrant1Id!;
    const r = advance(ms, feeder.id, arriving, 'played', new Set([waiting]));
    const settled = r.updates.find((u) => u.id === r2.id)!;
    assert.equal(settled.status, 'done');
    assert.equal(settled.outcome, 'dq');
    assert.equal(settled.winnerEntrantId, arriving);
});

test('two disqualified entrants meeting is left for a human, not awarded to nobody', () => {
    let ms = build(8);
    const m0 = at(ms, 1, 0);
    const m1 = at(ms, 1, 1);
    const a = m0.entrant1Id!;
    const b = m1.entrant1Id!;
    const out = new Set([a, b]);
    ms = applied(ms, advance(ms, m0.id, a, 'played', out).updates);
    const r = advance(ms, m1.id, b, 'played', out);

    // Both slots are filled and both occupants are out. Awarding it either way would be
    // inventing a winner, so it stays pending for the owner to settle.
    const next = r.updates.find((u) => u.id === m1.nextMatchId)!;
    assert.equal(next.status, 'pending');
    assert.equal(next.winnerEntrantId, null);
    assert.deepEqual([next.entrant1Id, next.entrant2Id].sort(), [a, b].sort());
    assert.equal(r.tournamentDone, false);
});

// ---------------------------------------------------------------- voiding

test('voiding a decided match clears it and empties the slot it filled', () => {
    let ms = build(8);
    const m0 = at(ms, 1, 0);
    ms = applied(ms, advance(ms, m0.id, m0.entrant1Id!, 'played').updates);

    const r = voidMatch(ms, m0.id);
    assert.equal(r.ok, true);
    const own = r.updates.find((u) => u.id === m0.id)!;
    assert.equal(own.status, 'pending');
    assert.equal(own.winnerEntrantId, null);
    assert.equal(own.outcome, null);
    // The entrants are still seated in the match itself — only the result went away.
    assert.equal(own.entrant1Id, m0.entrant1Id);

    const next = r.updates.find((u) => u.id === m0.nextMatchId)!;
    assert.equal(next.entrant1Id, null, 'the slot it fed is empty again');
});

test('THE ONE THAT MATTERS: voiding is refused when the next round is already decided', () => {
    let ms = build(8);
    const m0 = at(ms, 1, 0);
    const m1 = at(ms, 1, 1);
    ms = applied(ms, advance(ms, m0.id, m0.entrant1Id!, 'played').updates);
    ms = applied(ms, advance(ms, m1.id, m1.entrant1Id!, 'played').updates);
    const r2 = ms.find((m) => m.id === m0.nextMatchId)!;
    ms = applied(ms, advance(ms, r2.id, r2.entrant1Id!, 'played').updates);

    const r = voidMatch(ms, m0.id);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'next_round_decided');
    assert.deepEqual(r.updates, [], 'a refusal changes nothing at all');
});

test('cascade voids forwards, clearing the whole downstream branch', () => {
    let ms = build(8);
    const m0 = at(ms, 1, 0);
    const m1 = at(ms, 1, 1);
    ms = applied(ms, advance(ms, m0.id, m0.entrant1Id!, 'played').updates);
    ms = applied(ms, advance(ms, m1.id, m1.entrant1Id!, 'played').updates);
    const r2 = ms.find((m) => m.id === m0.nextMatchId)!;
    ms = applied(ms, advance(ms, r2.id, r2.entrant1Id!, 'played').updates);

    const r = voidMatch(ms, m0.id, true);
    assert.equal(r.ok, true);
    const after = applied(ms, r.updates);
    assert.equal(at(after, 1, 0).status, 'pending');
    assert.equal(at(after, 2, 0).status, 'pending', 'the downstream result went too');
    assert.equal(at(after, 2, 0).entrant1Id, null, 'and its slot was emptied');
    assert.equal(at(after, 2, 0).entrant2Id, m1.entrant1Id, 'the OTHER feeder is untouched');
});

test('a bye cannot be voided, and a pending match has nothing to void', () => {
    const ms = build(5);
    const bye = ms.find((m) => m.status === 'bye')!;
    assert.equal(voidMatch(ms, bye.id).reason, 'is_bye');
    const pending = ms.find((m) => m.round === 1 && m.status === 'pending')!;
    assert.equal(voidMatch(ms, pending.id).reason, 'not_decided');
    assert.equal(voidMatch(ms, 'nope').reason, 'match_not_found');
});

test('advance and voidMatch never mutate the bracket they were given', () => {
    const ms = build(8);
    const before = JSON.stringify(ms);
    const m0 = at(ms, 1, 0);
    advance(ms, m0.id, m0.entrant1Id!, 'played');
    disqualify(ms, m0.entrant1Id!);
    voidMatch(ms, m0.id, true);
    assert.equal(JSON.stringify(ms), before, 'the caller decides when anything is written');
});

/** Apply a set of updates the way the store will, so a test can chain calls. */
function applied(ms: BracketMatch[], updates: ReturnType<typeof advance>['updates']): BracketMatch[] {
    const byId = new Map(ms.map((m) => [m.id, { ...m }]));
    for (const u of updates) {
        const m = byId.get(u.id);
        if (!m) continue;
        if (u.entrant1Id !== undefined) m.entrant1Id = u.entrant1Id;
        if (u.entrant2Id !== undefined) m.entrant2Id = u.entrant2Id;
        if (u.winnerEntrantId !== undefined) m.winnerEntrantId = u.winnerEntrantId;
        if (u.status !== undefined) m.status = u.status;
        if (u.outcome !== undefined) m.outcome = u.outcome;
    }
    return [...byId.values()];
}
