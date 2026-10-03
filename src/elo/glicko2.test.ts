/**
 * The Glicko-2 engine. Run: `npm test`.
 *
 * Pure maths, so every rule is pinned on numbers: Glickman's own worked example (so the
 * implementation is Glicko-2 and not something that merely looks like it), the Lichess choices
 * on top of it, and the limits this ladder adds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    applyLimits, combinedRd, decayRd, DEFAULT_RATING, DEFAULT_RD, DEFAULT_VOLATILITY,
    MAX_DELTA, MAX_RD, MAX_VOLATILITY, MIN_RD, RATING_FLOOR, RATING_PERIODS_PER_DAY, rateSides,
    SCALE, TAU, updateMany, winProbability,
} from './glicko2';

const DAY = 24 * 60 * 60 * 1000;
const near = (a: number, b: number, eps: number, what = '') =>
    assert.ok(Math.abs(a - b) <= eps, `${what} ${a} vs ${b} (±${eps})`);

test('the constants are the ones the rules state', () => {
    assert.equal(TAU, 0.75);
    assert.equal(DEFAULT_RATING, 1500);
    assert.equal(DEFAULT_RD, 500);
    assert.equal(MIN_RD, 45);
    assert.equal(MAX_RD, 500);
    assert.equal(DEFAULT_VOLATILITY, 0.09);
    assert.equal(MAX_VOLATILITY, 0.1);
    assert.equal(RATING_PERIODS_PER_DAY, 0.21436);
    assert.equal(RATING_FLOOR, 400);
    assert.equal(MAX_DELTA, 700);
});

test("THE ONE THAT MATTERS: Glickman's worked example, with step 6", () => {
    // Glickman (2013), "Example of the Glicko-2 system": 1500/200/0.06, τ 0.5, beats a 1400/30,
    // loses to a 1550/100 and a 1700/300 → 1464.06 / 151.52 / 0.05999.
    const mu = 0;
    const games = [
        { r: 1400, rd: 30, s: 1 },
        { r: 1550, rd: 100, s: 0 },
        { r: 1700, rd: 300, s: 0 },
    ].map((o) => ({ muSelf: mu, muOpp: (o.r - 1500) / SCALE, phiOpp: o.rd / SCALE, score: o.s }));
    const out = updateMany({ rating: 1500, rd: 200, volatility: 0.06 }, games, { tau: 0.5, periodIncrease: true });
    near(out.rating, 1464.06, 0.01, 'rating');
    near(out.rd, 151.52, 0.01, 'rd');
    near(out.volatility, 0.05999, 0.00001, 'volatility');
});

test('no per-match period increase: the deviation only shrinks after a game', () => {
    const p = { id: 'a', rating: 1500, rd: 200, volatility: 0.06 };
    const q = { id: 'b', rating: 1500, rd: 200, volatility: 0.06 };
    const out = rateSides({ players: [p], score: 1 }, { players: [q], score: 0 });
    assert.ok(out.get('a')!.rd < 200, 'the winner is more certain');
    assert.ok(out.get('b')!.rd < 200, 'and so is the loser');
    // With step 6 the RD would come out larger than without it, every time.
    const withStep6 = updateMany(p, [{ muSelf: 0, muOpp: 0, phiOpp: 200 / SCALE, score: 1 }], { periodIncrease: true });
    assert.ok(withStep6.rd > out.get('a')!.rd);
});

test('uncertainty grows with time without playing: φ* = √(φ² + t·σ²)', () => {
    assert.equal(decayRd(100, 0.06, 0), 100);
    assert.equal(decayRd(100, 0.06, -5 * DAY), 100, 'a negative gap grows nothing');
    const t = 30 * RATING_PERIODS_PER_DAY;
    const expected = Math.sqrt((100 / SCALE) ** 2 + t * 0.06 ** 2) * SCALE;
    near(decayRd(100, 0.06, 30 * DAY), expected, 1e-9, '30 days');
    assert.ok(decayRd(100, 0.06, 30 * DAY) > 100);
    // Clamped both ways.
    assert.equal(decayRd(480, 0.1, 10_000 * DAY), MAX_RD);
    assert.equal(decayRd(10, 0.06, 0), MIN_RD);
});

test('the deviation and volatility stay inside their bounds after a match', () => {
    const a = { id: 'a', rating: 1500, rd: 46, volatility: 0.0999 };
    const b = { id: 'b', rating: 3000, rd: 46, volatility: 0.0999 };
    const out = rateSides({ players: [a], score: 1 }, { players: [b], score: 0 });
    for (const s of out.values()) {
        assert.ok(s.rd >= MIN_RD && s.rd <= MAX_RD, `rd ${s.rd}`);
        assert.ok(s.volatility <= MAX_VOLATILITY, `vol ${s.volatility}`);
    }
});

test('a 1v1 through rateSides is standard Glicko-2', () => {
    const a = { id: 'a', rating: 1620, rd: 120, volatility: 0.07 };
    const b = { id: 'b', rating: 1480, rd: 250, volatility: 0.09 };
    const out = rateSides({ players: [a], score: 0 }, { players: [b], score: 1 });
    const solo = updateMany(a, [{ muSelf: (1620 - 1500) / SCALE, muOpp: (1480 - 1500) / SCALE, phiOpp: 250 / SCALE, score: 0 }]);
    near(out.get('a')!.rating, solo.rating, 1e-9);
    near(out.get('a')!.rd, solo.rd, 1e-9);
});

test('teams: every teammate faces the same odds, and moves by his own uncertainty', () => {
    const vet = { id: 'vet', rating: 1600, rd: 60, volatility: 0.06 };
    const rookie = { id: 'rookie', rating: 1600, rd: 400, volatility: 0.09 };
    const o1 = { id: 'o1', rating: 1550, rd: 100, volatility: 0.06 };
    const o2 = { id: 'o2', rating: 1650, rd: 100, volatility: 0.06 };
    const out = rateSides({ players: [vet, rookie], score: 1 }, { players: [o1, o2], score: 0 });
    const dVet = out.get('vet')!.rating - 1600;
    const dRookie = out.get('rookie')!.rating - 1600;
    assert.ok(dVet > 0 && dRookie > 0, 'both winners gain');
    assert.ok(dRookie > dVet * 3, `the rookie moves far more (${dRookie} vs ${dVet})`);
    assert.ok(out.get('o1')!.rating < 1550 && out.get('o2')!.rating < 1650, 'both losers lose');
});

test('teams: the expectation comes from the team mean, not the player', () => {
    // Two teammates on very different ratings beat the same opponents: with the TEAM mean they
    // have the same expected score, so with equal deviations they gain the same.
    const hi = { id: 'hi', rating: 1900, rd: 150, volatility: 0.06 };
    const lo = { id: 'lo', rating: 1100, rd: 150, volatility: 0.06 };
    const o1 = { id: 'o1', rating: 1500, rd: 150, volatility: 0.06 };
    const o2 = { id: 'o2', rating: 1500, rd: 150, volatility: 0.06 };
    const out = rateSides({ players: [hi, lo], score: 1 }, { players: [o1, o2], score: 0 });
    near(out.get('hi')!.rating - 1900, out.get('lo')!.rating - 1100, 1e-9, 'equal gains');
});

test('combined deviation is the root mean square', () => {
    near(combinedRd([500, 500, 500]), 500, 1e-9, 'three newcomers stay as uncertain as one');
    near(combinedRd([60, 400]), Math.sqrt((60 ** 2 + 400 ** 2) / 2), 1e-9);
    assert.ok(combinedRd([60, 400]) > (60 + 400) / 2, 'a newcomer weighs more than the plain mean');
});

test('limits: the factor first, then ±700, then the floor of 400', () => {
    assert.equal(applyLimits(1500, 1520, 1), 1520);
    assert.equal(applyLimits(1500, 1520, 0.4), 1508);
    assert.equal(applyLimits(1500, 2600, 1), 2200, 'capped at +700');
    assert.equal(applyLimits(1500, 2600, 0.5), 2050, 'the factor before the cap');
    assert.equal(applyLimits(1500, 500, 1), 800, 'capped at −700');
    assert.equal(applyLimits(450, 300, 1), 400, 'never below the floor');
});

test('a newcomer beating a veteran far above him is capped', () => {
    const rookie = { id: 'r', rating: 1500, rd: 500, volatility: 0.09 };
    const vet = { id: 'v', rating: 2600, rd: 45, volatility: 0.06 };
    const raw = rateSides({ players: [rookie], score: 1 }, { players: [vet], score: 0 }).get('r')!;
    assert.ok(raw.rating - 1500 > 700, `raw gain ${raw.rating - 1500}`);
    assert.equal(applyLimits(1500, raw.rating, 1), 2200);
});

test('win probability: Glicko with both deviations, whole percent 1-99, null for an empty side', () => {
    const even = winProbability([{ rating: 1500, rd: 100 }], [{ rating: 1500, rd: 100 }]);
    assert.deepEqual(even, { a: 50, b: 50 });
    const fav = winProbability([{ rating: 1700, rd: 60 }], [{ rating: 1500, rd: 60 }])!;
    assert.ok(fav.a > 50 && fav.a + fav.b === 100);
    // More uncertainty pulls the favourite toward 50 %.
    const unsure = winProbability([{ rating: 1700, rd: 400 }], [{ rating: 1500, rd: 400 }])!;
    assert.ok(unsure.a < fav.a);
    const extreme = winProbability([{ rating: 3000, rd: 45 }], [{ rating: 400, rd: 45 }])!;
    assert.equal(extreme.a, 99);
    assert.equal(extreme.b, 1);
    assert.equal(winProbability([], [{ rating: 1500, rd: 100 }]), null);
    // Team means.
    const teams = winProbability(
        [{ rating: 1600, rd: 100 }, { rating: 1400, rd: 100 }],
        [{ rating: 1500, rd: 100 }, { rating: 1500, rd: 100 }])!;
    assert.deepEqual(teams, { a: 50, b: 50 });
});
