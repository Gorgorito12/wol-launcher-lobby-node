/**
 * How a roster's players get their names. Run: `npm test`.
 *
 * Same split as `listing.test.ts`: there is no database harness here, so what is pinned is
 * the SQL the decision is written in, plus the structural agreement between the two places
 * that need a person's name.
 *
 * The bug this guards is the one that made the change necessary. A bracket slot in a 3v3
 * holds a whole team, and the detail payload used to carry `member_ids` alone — identifiers,
 * which cannot be drawn. A team name by itself does not tell somebody whether they are in
 * the team, so the card could not answer the one question it exists to answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { USER_DISPLAY_NAME_SQL } from './store';

test('the display name falls back to the Discord handle and then to a placeholder', () => {
    // Three levels, in this order. A player who never set a name still has to be drawable,
    // and a row that cannot be joined at all must not render as an empty pill.
    assert.match(USER_DISPLAY_NAME_SQL, /COALESCE\(/);
    assert.match(USER_DISPLAY_NAME_SQL, /u\.display_name/);
    assert.match(USER_DISPLAY_NAME_SQL, /u\.discord_username/);
    assert.match(USER_DISPLAY_NAME_SQL, /'Unknown'/);

    const order = [
        USER_DISPLAY_NAME_SQL.indexOf('display_name'),
        USER_DISPLAY_NAME_SQL.indexOf('discord_username'),
        USER_DISPLAY_NAME_SQL.indexOf("'Unknown'"),
    ];
    assert.deepEqual([...order].sort((a, b) => a - b), order,
        'display_name must be preferred over the handle, and the handle over the placeholder');
});

test('THE ONE THAT MATTERS: an empty name counts as absent, not as a name', () => {
    // This is what makes the SQL match the JavaScript it replaced. `||` in JS treats ''
    // as falsy; plain COALESCE does not, and a player whose display_name is the empty
    // string would render as a blank pill next to two named teammates. NULLIF is the fix
    // and it must stay on BOTH columns.
    const nullifs = USER_DISPLAY_NAME_SQL.match(/NULLIF\(/g) ?? [];
    assert.equal(nullifs.length, 2,
        'both display_name and discord_username need NULLIF, or a blank one wins');
});

test('it is written against the alias every caller joins with', () => {
    // The fragment is embedded in queries that join `users u`. An unaliased column would
    // be ambiguous the moment the query also touches tournament_entrant_members, and the
    // failure is a SQL error at request time rather than anything a build would catch.
    for (const column of ['display_name', 'discord_username']) {
        assert.ok(
            USER_DISPLAY_NAME_SQL.includes(`u.${column}`),
            `${column} must be qualified with the u alias`,
        );
    }
});
