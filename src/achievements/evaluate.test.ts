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

function rated(i: number, p: Partial<MatchRow> & { opp?: string; oppRating?: number } = {}): MatchRow {
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

// ---------------------------------------------------------------- the medals added on 2026-11-26

const side = (mine: boolean, n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({
    userId: `${prefix}${i}`, team: mine ? 1 : 2, civ: 'French', result: mine ? 1 : 0, ratingBefore: null,
}));

test('Steadfast counts days, not matches', () => {
    const sameDay = Array.from({ length: 40 }, (_, i) => match({ atMs: T0 + i * 60_000, opp: `o${i}` }));
    assert.equal(evaluate(input(sameDay)).get('wol')!.get('steadfast')!.value, 1);
    const days = Array.from({ length: 30 }, (_, i) => match({ atMs: T0 + i * DAY }));
    assert.ok(earned(evaluate(input(days)), 'wol', 'steadfast'));
});

test('Invincible needs ten counted wins in a row', () => {
    const nine = Array.from({ length: 9 }, () => match({}));
    assert.ok(!earned(evaluate(input(nine)), 'wol', 'invincible'));
    assert.ok(earned(evaluate(input([...nine, match({})])), 'wol', 'invincible'));
});

test('Revenge: a 1v1 win against the player who beat you the last time', () => {
    assert.ok(earned(evaluate(input([match({ opp: 'r', result: 0 }), match({ opp: 'r' })])), 'wol', 'revenge'));
    // A win against someone else, or against a rival you had beaten: neither.
    assert.ok(!earned(evaluate(input([match({ opp: 'r', result: 0 }), match({ opp: 'other' })])), 'wol', 'revenge'));
    assert.ok(!earned(evaluate(input([match({ opp: 'r' }), match({ opp: 'r' })])), 'wol', 'revenge'));
    // A loss in a match that does not count is no grudge.
    assert.ok(!earned(evaluate(input([match({ opp: 'r', result: 0, durationSeconds: 60 }), match({ opp: 'r' })])), 'wol', 'revenge'));
});

test('Revenge is a 1v1 medal', () => {
    const others = [...side(true, 1, 'm'), ...side(false, 2, 'r')];
    const lost = match({ team: 1, result: 0, others: others.map((o) => ({ ...o, result: o.team === 1 ? 0 : 1 })) });
    const won = match({ team: 1, others });
    assert.ok(!earned(evaluate(input([lost, won])), 'wol', 'revenge'));
});

test('All-Rounder: a win in each of 1v1, 2v2 and 3v3', () => {
    const v2 = match({ team: 1, others: [...side(true, 1, 'a'), ...side(false, 2, 'b')] });
    const v3 = match({ team: 1, others: [...side(true, 2, 'c'), ...side(false, 3, 'd')] });
    const uneven = match({ team: 1, others: [...side(true, 1, 'e'), ...side(false, 3, 'f')] });
    assert.equal(evaluate(input([match({}), v2, uneven])).get('wol')!.get('all_rounder')!.value, 2);
    assert.ok(earned(evaluate(input([match({}), v2, v3])), 'wol', 'all_rounder'));
});

test('only matches the quick-match queue made count as quick matches', () => {
    const r = evaluate(input([match({}), match({ quickMatch: true })]));
    assert.ok(earned(r, 'wol', 'ready_for_battle'));
    assert.equal(r.get('wol')!.get('skirmisher')!.value, 1);
    assert.ok(!earned(evaluate(input([match({}), match({ quickMatch: true, result: 0 })])), 'wol', 'ready_for_battle'));
});

test('a continent needs a win with each of its civilizations', () => {
    const africa = ['Ethiopians', 'Egyptians', 'Zulu', 'Australians'].map((civ) => match({ civ }));
    assert.equal(evaluate(input(africa)).get('wol')!.get('africa_oceania')!.value, 4);
    assert.ok(earned(evaluate(input([...africa, match({ civ: 'Maori' })])), 'wol', 'africa_oceania'));
});

test('a historical war is won from either side, and only against the other', () => {
    const war = (civ: string, oppCiv: string, result = 1) => evaluate(input([match({ civ, oppCiv, result })]));
    assert.ok(earned(war('Paraguayans', 'Brazilians'), 'wol', 'war_triple_alliance'));
    assert.ok(earned(war('Uruguayans', 'Paraguayans'), 'wol', 'war_triple_alliance'));
    assert.ok(!earned(war('Argentines', 'Brazilians'), 'wol', 'war_triple_alliance'));
    assert.ok(!earned(war('Paraguayans', 'Brazilians', 0), 'wol', 'war_triple_alliance'));
    assert.ok(earned(war('Spanish', 'Mexicans'), 'wol', 'war_independence'));
    assert.ok(!earned(war('Spanish', 'Brazilians'), 'wol', 'war_independence'));
});

test('the tournament medals come from their events, in their own game', () => {
    const ev = [{ modKey: 'wol', atMs: T0, tournamentId: 't1' }];
    const r = evaluate(input([], { tournamentsPlayed: ev, finalistOf: ev }));
    assert.ok(earned(r, 'wol', 'in_the_bracket'));
    assert.ok(earned(r, 'wol', 'finalist'));
    assert.ok(!earned(r, 'wol', 'champion'));
    const other = evaluate(input([match({})], { tournamentsPlayed: ev.map((e) => ({ ...e, modKey: TAD_KEY })) }));
    assert.ok(!earned(other, 'wol', 'in_the_bracket'));
    assert.ok(earned(other, TAD_KEY, 'in_the_bracket'));
});

// ---------------------------------------------------------------- the feats (platinum, 2026-11-26)

test('Number One is the first place of a table of ten, never the second or a small table', () => {
    const rows = [rated(1)];
    assert.ok(earned(evaluate(input(rows, { position: { default: { rank: 1, size: 12 } } })), 'wol', 'number_one'));
    assert.ok(!earned(evaluate(input(rows, { position: { default: { rank: 2, size: 12 } } })), 'wol', 'number_one'));
    assert.ok(!earned(evaluate(input(rows, { position: { default: { rank: 1, size: 9 } } })), 'wol', 'number_one'));
    // Second place is still On Top.
    assert.ok(earned(evaluate(input(rows, { position: { default: { rank: 2, size: 12 } } })), 'wol', 'on_top'));
});

test('Iron Streak counts competitive 1v1 wins only; a casual match neither adds nor breaks it', () => {
    const ten = Array.from({ length: 10 }, (_, i) => rated(i, { opp: `r${i}` }));
    const withCasuals = ten.flatMap((m, i) => (i === 4 ? [m, match({ result: 0 }), match({})] : [m]));
    const r = evaluate(input(withCasuals));
    assert.ok(earned(r, 'wol', 'iron_streak'));
    const nineAndCasual = [...ten.slice(0, 9), match({})];
    assert.equal(evaluate(input(nineAndCasual)).get('wol')!.get('iron_streak')!.value, 9);
    const broken = [...ten.slice(0, 5), rated(20, { result: 0 }), ...ten.slice(5)];
    assert.ok(!earned(evaluate(input(broken)), 'wol', 'iron_streak'));
});

test('a team win does not feed the 1v1 streak', () => {
    const rows = Array.from({ length: 10 }, (_, i) => rated(i, { ratingMode: 'team', opp: `t${i}` }));
    assert.ok(!earned(evaluate(input(rows)), 'wol', 'iron_streak'));
});

test('Triple Crown is the third tournament won in this game', () => {
    const ev = (n: number, mod = 'wol') => Array.from({ length: n }, (_, i) => ({ modKey: mod, atMs: T0 + i, tournamentId: `t${i}` }));
    const two = evaluate(input([match({})], { championOf: ev(2) }));
    assert.ok(earned(two, 'wol', 'champion'));
    assert.ok(!earned(two, 'wol', 'triple_crown'));
    assert.equal(two.get('wol')!.get('triple_crown')!.value, 2);
    const three = evaluate(input([match({})], { championOf: ev(3) }));
    assert.equal(three.get('wol')!.get('triple_crown')!.earned[0]!.tournamentId, 't2');
    assert.ok(!earned(evaluate(input([match({})], { championOf: [...ev(2), ...ev(1, TAD_KEY)] })), 'wol', 'triple_crown'));
});

test('Living Legend counts the stored medals too, and never itself', () => {
    const goal = evaluate(input([match({})])).get('wol')!.get('living_legend')!.goal!;
    assert.equal(goal, 54);
    // One match earns two medals; 52 stored ones bring it to 54.
    const stored = Array.from({ length: 52 }, (_, i) => `stored_${i}|0`);
    assert.ok(earned(evaluate(input([match({})], { held: { wol: stored } })), 'wol', 'living_legend'));
    // Its own stored row does not count toward it.
    const withItself = [...stored.slice(0, 51), 'living_legend|0'];
    assert.ok(!earned(evaluate(input([match({})], { held: { wol: withItself } })), 'wol', 'living_legend'));
    // A medal held in another game does not count here.
    assert.ok(!earned(evaluate(input([match({})], { held: { [TAD_KEY]: stored } })), 'wol', 'living_legend'));
});
