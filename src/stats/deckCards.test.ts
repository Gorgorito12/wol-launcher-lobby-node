/**
 * Which cards the community BRINGS. Run: `npm test`.
 *
 * Same shape as ladder.test.ts and for the reason stated there: no database harness, the SQL
 * is verified against the real table on deploy, and what is pinned here is the decision it
 * encodes.
 *
 * This one carries data off a player's own disk, so two of its rules are about honesty rather
 * than about correctness:
 *
 *   - it counts PEOPLE, not rows, or one player with a card in four decks reads as four;
 *   - an upload REPLACES that player's cards, or somebody who opens the launcher daily is
 *     counted daily and the table measures restarts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DECK_CARDS_SQL } from './rest';

interface Row { user: string; mod: string; civ: string; card: string }

/** Three players. Two carry Expanded Trading Post for the Chinese; one has it twice over. */
const ROWS: Row[] = [
    { user: 'u1', mod: 'wol', civ: 'Chinese', card: 'YPHCExpandedTradingPost' },
    { user: 'u2', mod: 'wol', civ: 'Chinese', card: 'YPHCExpandedTradingPost' },
    { user: 'u1', mod: 'wol', civ: 'Chinese', card: 'HCShipBalloons' },
    { user: 'u1', mod: 'wol', civ: 'Ottomans', card: 'YPHCExpandedTradingPost' },
    { user: 'u3', mod: 'wol', civ: 'Ottomans', card: 'HCAdmirality' },
];

/** The GROUP BY and its COUNT(DISTINCT user_id), reproduced so they can be asserted. */
function aggregate(rows: Row[]) {
    const byKey = new Map<string, { mod: string; civ: string; card: string; users: Set<string> }>();
    for (const r of rows) {
        const key = `${r.mod}|${r.civ}|${r.card}`;
        const cell = byKey.get(key) ?? { mod: r.mod, civ: r.civ, card: r.card, users: new Set<string>() };
        cell.users.add(r.user);
        byKey.set(key, cell);
    }
    return [...byKey.values()]
        .map(c => ({ mod_id: c.mod, civ: c.civ, card: c.card, players: c.users.size }))
        .sort((a, b) => b.players - a.players
            || a.civ.localeCompare(b.civ)
            || a.card.localeCompare(b.card));
}

test('it counts people, never rows', () => {
    const top = aggregate(ROWS)[0];
    assert.equal(top.card, 'YPHCExpandedTradingPost');
    assert.equal(top.civ, 'Chinese');
    assert.equal(top.players, 2);

    assert.ok(DECK_CARDS_SQL.includes('COUNT(DISTINCT user_id)'),
        'a plain COUNT(*) would count decks, not carriers');
});

test('the same card for two civilizations is two separate facts', () => {
    // u1 carries it for the Chinese AND the Ottomans. Grouping without the civ would merge
    // them and report one player carrying it twice, which is not a thing anyone can do.
    const rows = aggregate(ROWS).filter(r => r.card === 'YPHCExpandedTradingPost');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.civ).sort(), ['Chinese', 'Ottomans']);

    assert.ok(DECK_CARDS_SQL.includes('GROUP BY mod_id, civ, card'));
});

test('two mods never average together', () => {
    // The same card name in a different mod is a different card. Same reasoning as the civ
    // table's grouping by mod and version.
    const mixed = aggregate([
        ...ROWS,
        { user: 'u9', mod: 'improvement-mod', civ: 'Chinese', card: 'YPHCExpandedTradingPost' },
    ]);
    const chinese = mixed.filter(r => r.civ === 'Chinese' && r.card === 'YPHCExpandedTradingPost');
    assert.equal(chinese.length, 2);
    assert.equal(chinese.find(r => r.mod_id === 'wol')!.players, 2);
    assert.equal(chinese.find(r => r.mod_id === 'improvement-mod')!.players, 1);
});

test('the order is stable, so the table does not reshuffle between visits', () => {
    const once = aggregate(ROWS).map(r => `${r.civ}|${r.card}`);
    const again = aggregate([...ROWS].reverse()).map(r => `${r.civ}|${r.card}`);
    assert.deepEqual(once, again);

    assert.ok(DECK_CARDS_SQL.includes('ORDER BY players DESC, civ ASC, card ASC'));
});

test('the query still takes its minimum and its limit, in that order', () => {
    const marks = DECK_CARDS_SQL.split('?').length - 1;
    assert.equal(marks, 2, `expected 2 bind parameters, found ${marks}`);
    assert.ok(DECK_CARDS_SQL.indexOf('LIMIT ?') > DECK_CARDS_SQL.indexOf('HAVING players >= ?'));
});

test('nothing here records WHEN or WHAT was played', () => {
    // The table is a popularity count of what people TAKE. A recording carries neither the
    // card played nor the deck it came from, so any column implying otherwise would be a
    // claim nothing can support — and this data is self-declared, so it must never reach the
    // rating path either.
    for (const forbidden of ['match', 'result', 'rating', 'played_at', 'won']) {
        assert.ok(!DECK_CARDS_SQL.includes(forbidden),
            `the aggregate mentions "${forbidden}" — this counts what is BROUGHT, nothing more`);
    }
});
