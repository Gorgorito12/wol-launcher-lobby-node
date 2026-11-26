/**
 * The medal rules, pure (design 121). Run: `npm test`.
 *
 * Most cases are refusals: a medal handed out wrongly cannot be taken back by the code (they are
 * never lost), so what must NOT count is the part that matters — another game's wins, a farmed
 * rival, a crash void, a placement number, a tiny ladder.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, type EvalInput, type MatchRow } from './evaluate';
import { TAD_KEY } from './catalog';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1);

let seq = 0;
function match(p: Partial<MatchRow> & { opp?: string; oppCiv?: string; oppRating?: number }): MatchRow {
    seq += 1;
    const { opp, oppCiv, oppRating, ...rest } = p;
    return {
        matchId: `m${seq}`,
        atMs: T0 + seq * 60_000,
        modKey: 'wol',
        mapName: 'amazonia',
        durationSeconds: 1500,
        rated: 0,
        unratedReason: 'not_competitive',
        decidedBy: null,
        ratingMode: 'default',
        eloFactor: null,
        lobbyId: `l${seq}`,
        gameRules: 0,
        rosterOk: true,
        team: 0,
        civ: 'British',
        result: 1,
        ratingBefore: null,
        ratingAfter: null,
        others: [{ userId: opp ?? `u${seq}`, team: 0, civ: oppCiv ?? 'French', result: 0, ratingBefore: oppRating ?? null }],
        ...rest,
    };
}

function input(matches: MatchRow[], extra: Partial<EvalInput> = {}): EvalInput {
    return {
        userId: 'me', nowMs: T0 + 400 * DAY, matches, hostedRooms: [], championOf: [], organiserOf: [],
        gamesPlayed: { default: 0, team: 0 }, ...extra,
    };
}

const earned = (r: ReturnType<typeof evaluate>, mod: string, id: string) => (r.get(mod)?.get(id)?.earned ?? []).length > 0;

test('the first match and the first win earn their medals', () => {
    const r = evaluate(input([match({})]));
    assert.ok(earned(r, 'wol', 'baptism_of_fire'));
    assert.ok(earned(r, 'wol', 'first_blood'));
    assert.ok(!earned(r, 'wol', 'veteran'));
    assert.equal(r.get('wol')!.get('veteran')!.value, 1);
});

test("THE_ONE_THAT_MATTERS: Wars of Liberty's wins count for nothing in TAD", () => {
    const rows = Array.from({ length: 12 }, () => match({}));
    const r = evaluate(input(rows));
    assert.equal(r.get('wol')!.get('conqueror')!.value, 12);
    assert.ok(!r.has(TAD_KEY));
});

test('a match that is not countable earns nothing', () => {
    const refused = [
        match({ lobbyId: null }),
        match({ durationSeconds: 120 }),
        match({ rosterOk: false }),
        match({ unratedReason: 'game_crashed' }),
        match({ unratedReason: 'duplicate_recording' }),
        match({ unratedReason: 'implausible_timing' }),
        match({ unratedReason: 'new_account_short' }),
        match({ unratedReason: 'contradicted_founding' }),
    ];
    const r = evaluate(input(refused));
    assert.ok(!earned(r, 'wol', 'baptism_of_fire'));
    assert.ok(!earned(r, 'wol', 'first_blood'));
});

test('at most three wins a day against the same rival count', () => {
    const rows = Array.from({ length: 6 }, () => match({ opp: 'friend' }));
    const r = evaluate(input(rows));
    assert.equal(r.get('wol')!.get('conqueror')!.value, 3);
    // Another day, three more.
    const next = Array.from({ length: 3 }, (_, i) => match({ opp: 'friend', atMs: T0 + DAY + i * 60_000 }));
    const r2 = evaluate(input([...rows, ...next]));
    assert.equal(r2.get('wol')!.get('conqueror')!.value, 6);
});

test('a rated win the ELO discounted below half earns no medal and breaks no streak', () => {
    const rows = [
        ...Array.from({ length: 4 }, () => match({})),
        match({ rated: 1, unratedReason: null, eloFactor: 0.4 }),
        match({}),
    ];
    const r = evaluate(input(rows));
    assert.equal(r.get('wol')!.get('conqueror')!.value, 5);
    assert.ok(earned(r, 'wol', 'unstoppable'));
});

test('a loss breaks the streak', () => {
    const rows = [match({}), match({}), match({}), match({}), match({ result: 0 }), match({})];
    assert.ok(!earned(evaluate(input(rows)), 'wol', 'unstoppable'));
});

test('Phoenix: a win right after three losses', () => {
    const rows = [match({ result: 0 }), match({ result: 0 }), match({ result: 0 }), match({})];
    assert.ok(earned(evaluate(input(rows)), 'wol', 'phoenix'));
    const notYet = [match({ result: 0 }), match({ result: 0 }), match({})];
    assert.ok(!earned(evaluate(input(notYet)), 'wol', 'phoenix'));
});

function rated(i: number, p: Partial<MatchRow> & { oppRating?: number } = {}): MatchRow {
    return match({ rated: 1, unratedReason: null, ratingAfter: 1500 + i, ratingBefore: 1500 + i - 1, ...p });
}

test('the ELO medals are locked while being placed', () => {
    const rows = Array.from({ length: 5 }, (_, i) => rated(i, { ratingAfter: 1900 }));
    const r = evaluate(input(rows, { gamesPlayed: { default: 5, team: 0 } }));
    const contender = r.get('wol')!.get('contender')!;
    assert.equal(contender.locked, 'placement');
    assert.equal(contender.value, undefined);
    assert.ok(!earned(r, 'wol', 'contender'));
});

test('reaching 1600 needs a WIN of this game past placement', () => {
    const rows = [
        ...Array.from({ length: 10 }, (_, i) => rated(i)),
        rated(11, { result: 0, ratingAfter: 1650 }),
    ];
    const r = evaluate(input(rows, { gamesPlayed: { default: 11, team: 0 } }));
    assert.ok(!earned(r, 'wol', 'contender'));
    assert.equal(r.get('wol')!.get('contender')!.value, 1650);
    const won = evaluate(input([...rows, rated(12, { ratingAfter: 1610 })], { gamesPlayed: { default: 12, team: 0 } }));
    assert.ok(earned(won, 'wol', 'contender'));
    assert.ok(!earned(won, 'wol', 'elite'));
});

test('a rating reached in placement does not count', () => {
    const rows = [rated(1, { ratingAfter: 1700 }), ...Array.from({ length: 9 }, (_, i) => rated(i + 2, { ratingAfter: 1550 }))];
    const r = evaluate(input(rows, { gamesPlayed: { default: 10, team: 0 } }));
    assert.ok(!earned(r, 'wol', 'contender'));
});

test('Graduate goes to the game of the match that finished placement', () => {
    const rows = [
        ...Array.from({ length: 9 }, (_, i) => rated(i, { modKey: TAD_KEY })),
        rated(10, { modKey: 'wol' }),
    ];
    const r = evaluate(input(rows));
    assert.ok(earned(r, 'wol', 'graduate'));
    assert.ok(!earned(r, TAD_KEY, 'general') && !r.get(TAD_KEY)!.has('graduate'));
});

test('Giant Slayer: beating someone 200 above, never in placement', () => {
    const placed = Array.from({ length: 10 }, (_, i) => rated(i));
    const slay = rated(11, { ratingBefore: 1500, others: [{ userId: 'big', team: 0, civ: 'French', result: 0, ratingBefore: 1720 }] });
    assert.ok(earned(evaluate(input([...placed, slay])), 'wol', 'giant_slayer'));
    const early = rated(1, { ratingBefore: 1500, others: [{ userId: 'big', team: 0, civ: 'French', result: 0, ratingBefore: 1720 }] });
    assert.ok(!earned(evaluate(input([early])), 'wol', 'giant_slayer'));
});

test('Promotion and On Top need a table of ten', () => {
    const rows = [rated(1)];
    const small = evaluate(input(rows, { position: { default: { rank: 1, size: 4 } } }));
    assert.equal(small.get('wol')!.get('promotion')!.earned.length, 0);
    assert.ok(!earned(small, 'wol', 'on_top'));
    const big = evaluate(input(rows, { position: { default: { rank: 1, size: 20 } } }));
    assert.equal(big.get('wol')!.get('promotion')!.earned.length, 5);
    assert.ok(earned(big, 'wol', 'on_top'));
});

test('Promotion is cumulative: an industrial player holds colonial and fortress too', () => {
    const r = evaluate(input([rated(1)], { position: { default: { rank: 8, size: 20 } } }));
    const tiers = r.get('wol')!.get('promotion')!.earned.map((e) => e.tier);
    assert.deepEqual(tiers, [1, 2, 3]);
});

test("a place on the ladder is credited to the game of the latest rated match", () => {
    const rows = [rated(1, { modKey: 'wol' }), rated(2, { modKey: TAD_KEY })];
    const r = evaluate(input(rows, { position: { default: { rank: 1, size: 20 } } }));
    assert.ok(earned(r, TAD_KEY, 'promotion'));
    assert.ok(!earned(r, 'wol', 'promotion'));
});

test("TAD's family medals and rivalries", () => {
    const rows = [
        match({ modKey: TAD_KEY, civ: 'Chinos', oppCiv: 'Japoneses' }),
        match({ modKey: TAD_KEY, civ: 'Japanese', oppCiv: 'British' }),
        match({ modKey: TAD_KEY, civ: 'Indians', oppCiv: 'Indians' }),
    ];
    const r = evaluate(input(rows));
    assert.ok(earned(r, TAD_KEY, 'asian_dynasties'));
    assert.ok(earned(r, TAD_KEY, 'duel_of_dynasties'));
    assert.ok(earned(r, TAD_KEY, 'clash_of_civilizations'));
    assert.ok(earned(r, TAD_KEY, 'mirror'));
    assert.ok(!earned(r, TAD_KEY, 'native_resistance'));
    assert.equal(r.get(TAD_KEY)!.get('complete_empire')!.value, 3);
});

test('the room rules decide the rule medals', () => {
    const r = evaluate(input([
        match({ modKey: TAD_KEY, gameRules: 5 }),
        match({ modKey: TAD_KEY, gameRules: 1 }),
    ]));
    assert.ok(earned(r, TAD_KEY, 'non_aggression_pact'));
    assert.ok(earned(r, TAD_KEY, 'long_treaty'));
    assert.ok(earned(r, TAD_KEY, 'classic'));
    assert.ok(!earned(r, TAD_KEY, 'king_of_the_hill'));
});

test('a match decided without its game finishing earns no duration medal', () => {
    const r = evaluate(input([match({ durationSeconds: 600, decidedBy: 'abandon' })]));
    assert.ok(!earned(r, 'wol', 'lightning_war'));
    assert.ok(earned(evaluate(input([match({ durationSeconds: 600 })])), 'wol', 'lightning_war'));
});

test('a team win is a win with a teammate', () => {
    const team = match({
        team: 1,
        others: [
            { userId: 'mate', team: 1, civ: 'Dutch', result: 1, ratingBefore: null },
            { userId: 'x', team: 2, civ: 'French', result: 0, ratingBefore: null },
            { userId: 'y', team: 2, civ: 'Spanish', result: 0, ratingBefore: null },
        ],
    });
    const r = evaluate(input([team]));
    assert.equal(r.get('wol')!.get('brothers_in_arms')!.value, 1);
    assert.equal(r.get('wol')!.get('diplomat')!.value, 2);
});

test('Host counts the rooms he opened in this game', () => {
    const rooms = Array.from({ length: 20 }, (_, i) => ({ modKey: 'wol', atMs: T0 + i, lobbyId: `r${i}` }));
    const r = evaluate(input([match({})], { hostedRooms: rooms }));
    assert.ok(earned(r, 'wol', 'host'));
    const tad = evaluate(input([match({})], { hostedRooms: rooms.map((x) => ({ ...x, modKey: TAD_KEY })) }));
    assert.ok(!earned(tad, 'wol', 'host'));
});

test('evaluating twice gives the same answer', () => {
    const rows = Array.from({ length: 8 }, () => match({}));
    const a = evaluate(input(rows));
    const b = evaluate(input(rows));
    const flat = (m: ReturnType<typeof evaluate>) => JSON.stringify([...m.get('wol')!.entries()].map(([k, v]) => [k, v.earned]));
    assert.equal(flat(a), flat(b));
});
