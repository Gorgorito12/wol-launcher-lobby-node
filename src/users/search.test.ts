/**
 * Finding a player by name, for a team invitation or a line-up. Run: `npm test`.
 *
 * The limits are the point: it must not be a way to list the user table, nor to find a banned
 * account, nor treat the user's own `%` or `_` as wildcards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseSearchQuery, USER_SEARCH_SQL, userSearchParams, SEARCH_LIMIT,
} from './search';

test('a fragment too short to mean anything finds nobody', () => {
    assert.equal(parseSearchQuery(undefined), null);
    assert.equal(parseSearchQuery(''), null);
    assert.equal(parseSearchQuery(' a '), null);
    assert.equal(parseSearchQuery(['ana']), null);
});

test('the fragment is trimmed and capped', () => {
    assert.equal(parseSearchQuery('  ana '), 'ana');
    assert.equal(parseSearchQuery('x'.repeat(100))!.length, 32);
});

test('THE ONE THAT MATTERS: never banned accounts, never the caller, never more than ten', () => {
    assert.match(USER_SEARCH_SQL, /is_banned = 0/);
    assert.match(USER_SEARCH_SQL, /id <> \?/);
    assert.match(USER_SEARCH_SQL, new RegExp(`LIMIT ${SEARCH_LIMIT}$`));
    assert.equal(SEARCH_LIMIT, 10);
});

test('the user\'s own % and _ are matched literally, not as wildcards', () => {
    const [caller, display, discord] = userSearchParams('me', '50%_off');
    assert.equal(caller, 'me');
    assert.equal(display, String.raw`%50\%\_off%`);
    assert.equal(discord, display);
    assert.ok(USER_SEARCH_SQL.includes(String.raw`ESCAPE '\'`));
});
