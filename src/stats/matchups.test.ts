/**
 * Civilization against civilization. Run: `npm test`.
 *
 * Same shape as ladder.test.ts and for the same stated reason: there is no database harness in
 * this repo, the SQL is verified against the real table on deploy, and what is pinned here is
 * the DECISION the SQL encodes.
 *
 * A self-join over match_participants has three ways to be quietly wrong, and none of them
 * errors, fails a typecheck or produces an empty table — they produce a table that looks
 * perfectly reasonable and is not true:
 *
 *   1. every pair counted twice, once from each side, with mirrored records
 *   2. a player joined to themselves, so every match becomes a matchup against its own civ
 *   3. a different rated/1v1 filter from /stats/civs, so a civ's overall record stops
 *      reconciling with the sum of its matchups
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MATCHUPS_SQL } from './rest';

/** One row of match_participants, reduced to what the query looks at. */
interface P { match: string; user: string; civ: string; result: number }

/** A rated 1v1 corpus: two Chinese wins over the Ottomans, one loss, and a mirror. */
const ROWS: P[] = [
    { match: 'm1', user: 'u1', civ: 'Chinese', result: 1 },
    { match: 'm1', user: 'u2', civ: 'Ottomans', result: 0 },
    { match: 'm2', user: 'u2', civ: 'Chinese', result: 1 },
    { match: 'm2', user: 'u3', civ: 'Ottomans', result: 0 },
    { match: 'm3', user: 'u1', civ: 'Chinese', result: 0 },
    { match: 'm3', user: 'u3', civ: 'Ottomans', result: 1 },
    { match: 'm4', user: 'u1', civ: 'Russians', result: 1 },
    { match: 'm4', user: 'u2', civ: 'Russians', result: 0 },
];

/**
 * The self-join, reproduced in JS exactly as the SQL declares it — including the two clauses
 * that make it correct — so the pairing rules can be asserted rather than described.
 */
function matchups(rows: P[]) {
    const out = new Map<string, { civ_a: string; civ_b: string; played: number; wins_a: number; losses_a: number }>();

    for (const a of rows) {
        for (const b of rows) {
            if (b.match !== a.match) continue;
            if (b.user === a.user) continue;      // b.user_id <> a.user_id
            if (!(a.civ < b.civ)) continue;       // a.civ < b.civ

            const key = `${a.civ}|${b.civ}`;
            const row = out.get(key) ?? { civ_a: a.civ, civ_b: b.civ, played: 0, wins_a: 0, losses_a: 0 };
            row.played++;
            if (a.result >= 0.999) row.wins_a++;
            if (a.result <= 0.001) row.losses_a++;
            out.set(key, row);
        }
    }

    return [...out.values()].sort((x, y) =>
        y.played - x.played || x.civ_a.localeCompare(y.civ_a) || x.civ_b.localeCompare(y.civ_b));
}

test('each pair is counted once, from one canonical side', () => {
    const rows = matchups(ROWS);

    // Three matches between the two, never six. Without `a.civ < b.civ` the self-join sees each
    // match from both players and the same games appear again as "Ottomans vs Chinese".
    const cn = rows.find(r => r.civ_a === 'Chinese' && r.civ_b === 'Ottomans');
    assert.ok(cn, 'the Chinese/Ottomans pair is missing');
    assert.equal(cn!.played, 3);
    assert.equal(cn!.wins_a, 2);
    assert.equal(cn!.losses_a, 1);

    assert.equal(rows.filter(r => r.civ_b === 'Chinese').length, 0,
        'the same pair came back with the sides swapped — it is being counted twice');
});

test('a mirror matchup is dropped, not listed at 50%', () => {
    // Russians vs Russians is 50% by construction and says nothing about balance. `a.civ < b.civ`
    // is false for equal names, so it never forms a row.
    assert.equal(matchups(ROWS).filter(r => r.civ_a === r.civ_b).length, 0);
    assert.ok(MATCHUPS_SQL.includes('a.civ < b.civ'));
});

test('nobody is ever joined to themselves', () => {
    // Drop the guard and a 1v1 becomes two matchups of a civ against itself, with the player
    // counted as both winner and loser. The SQL clause is what stops it.
    assert.ok(MATCHUPS_SQL.includes('b.user_id <> a.user_id'));

    const selfJoined = ROWS.filter(a => ROWS.some(b => b.match === a.match && b.user === a.user && b !== a));
    assert.equal(selfJoined.length, 0, 'the fixture itself has a duplicate participant');
});

test('the rated-1v1 filter is the same one /stats/civs uses', () => {
    // If these two tables filtered differently, a civilization's overall record would not
    // reconcile with the sum of its matchups and neither number could be trusted. NULL means
    // 1v1 — every match stored before migration 0010 has it and they were all 1v1s.
    assert.ok(MATCHUPS_SQL.includes('m.rated = 1'));
    assert.ok(MATCHUPS_SQL.includes("(m.rating_mode IS NULL OR m.rating_mode = 'default')"));
});

test('a draw is played but neither won nor lost', () => {
    // Most stored matches are 0.5, because the game does not record by default. They have to
    // count as played — the pair exists — while leaving the record at 0-0 so the launcher can
    // withhold a percentage rather than print a false one.
    const draws: P[] = [
        { match: 'd1', user: 'u1', civ: 'Chinese', result: 0.5 },
        { match: 'd1', user: 'u2', civ: 'Ottomans', result: 0.5 },
    ];
    const [row] = matchups(draws);
    assert.equal(row.played, 1);
    assert.equal(row.wins_a, 0);
    assert.equal(row.losses_a, 0);
});

test('the query still takes its minimum and its limit, in that order', () => {
    const marks = MATCHUPS_SQL.split('?').length - 1;
    assert.equal(marks, 2, `expected 2 bind parameters, found ${marks}`);
    assert.ok(MATCHUPS_SQL.indexOf('LIMIT ?') > MATCHUPS_SQL.indexOf('HAVING played >= ?'));
});

test('a civilization that could not be resolved is excluded, not grouped as blank', () => {
    // civ is null whenever the roster could not be joined to the recording, which is ordinary.
    // Counting those together produces a nameless row at the top of the table.
    assert.ok(MATCHUPS_SQL.includes("a.civ IS NOT NULL AND TRIM(a.civ) <> ''"));
    assert.ok(MATCHUPS_SQL.includes("b.civ IS NOT NULL AND TRIM(b.civ) <> ''"));
});
