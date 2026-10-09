import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../lib/errors';
import {
    BROWSE_DEFAULT_LIMIT, BROWSE_MAX_LIMIT, browseCountSql, browseSql, decodeCursor, encodeCursor,
    likePattern, parseBrowseQuery, type BrowseFilters,
} from './browse';

const NONE: BrowseFilters = { limit: 30, cursor: null, q: null, replayOnly: false, mod: null };

test('a cursor survives the round trip', () => {
    const c = encodeCursor('2026-10-09 18:00:00', 'abc-123');
    assert.match(c, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeCursor(c), { createdAt: '2026-10-09 18:00:00', id: 'abc-123' });
});

test('a cursor the server did not issue is a 400, never a silent first page', () => {
    for (const bad of [
        'not base64!!',
        Buffer.from('no-bar', 'utf8').toString('base64url'),
        Buffer.from('yesterday|abc', 'utf8').toString('base64url'),
        Buffer.from("2026-10-09 18:00:00|abc'; DROP TABLE matches", 'utf8').toString('base64url'),
        'x'.repeat(500),
    ]) {
        assert.throws(() => decodeCursor(bad), (e: unknown) => e instanceof HttpError && e.status === 400 && e.code === 'bad_cursor', bad);
    }
});

test('a search matches its text literally: LIKE wildcards are escaped', () => {
    assert.equal(likePattern('kaiser'), '%kaiser%');
    assert.equal(likePattern('50%_off\\x'), '%50\\%\\_off\\\\x%');
});

test('the query parameters fall back rather than erroring, and are clamped', () => {
    assert.deepEqual(parseBrowseQuery(undefined), NONE);
    assert.equal(parseBrowseQuery({ limit: 'abc' }).limit, BROWSE_DEFAULT_LIMIT);
    assert.equal(parseBrowseQuery({ limit: '0' }).limit, 1);
    assert.equal(parseBrowseQuery({ limit: '9999' }).limit, BROWSE_MAX_LIMIT);
    assert.equal(parseBrowseQuery({ q: 'k' }).q, null, 'one letter matches everybody');
    assert.equal(parseBrowseQuery({ q: '  Kai\tser  ' }).q, 'Kai ser');
    assert.equal(parseBrowseQuery({ q: 'x'.repeat(100) }).q?.length, 32);
    assert.equal(parseBrowseQuery({ replay: '1' }).replayOnly, true);
    assert.equal(parseBrowseQuery({ replay: '0' }).replayOnly, false);
    assert.equal(parseBrowseQuery({ mod: '  wol ' }).mod, 'wol');
    assert.equal(parseBrowseQuery({ mod: '   ' }).mod, null);
});

test('with no filters the page has no WHERE and asks for one extra row', () => {
    const { sql, params } = browseSql(NONE);
    assert.doesNotMatch(sql, /WHERE/);
    assert.match(sql, /ORDER BY m\.created_at DESC, m\.id DESC/);
    assert.deepEqual(params, [31]);
});

test('every filter adds its clause and its parameters, in order', () => {
    const f: BrowseFilters = {
        limit: 10,
        cursor: { createdAt: '2026-10-09 18:00:00', id: 'm9' },
        q: 'kai',
        replayOnly: true,
        mod: 'wol',
    };
    const { sql, params } = browseSql(f);
    assert.match(sql, /m\.mod_id = \?/);
    assert.match(sql, /m\.replay_key IS NOT NULL AND m\.replay_uploaded_at > datetime\('now', '-365 days'\)/);
    assert.match(sql, /u\.display_name LIKE \? ESCAPE '\\' OR u\.discord_username LIKE \? ESCAPE '\\'/);
    assert.match(sql, /\(m\.created_at < \? OR \(m\.created_at = \? AND m\.id < \?\)\)/);
    assert.deepEqual(params, ['wol', '%kai%', '%kai%', '2026-10-09 18:00:00', '2026-10-09 18:00:00', 'm9', 11]);
});

test('the count describes the whole list: it ignores the cursor', () => {
    const f: BrowseFilters = { ...NONE, cursor: { createdAt: '2026-10-09 18:00:00', id: 'm9' }, mod: 'wol' };
    const { sql, params } = browseCountSql(f);
    assert.match(sql, /^SELECT COUNT\(\*\) AS n FROM matches m WHERE m\.mod_id = \?$/);
    assert.deepEqual(params, ['wol']);
});

test('the object key is selected for the server and never named in the client shape', () => {
    // The route strips it; this pins that the SELECT is where it comes from, so a refactor that
    // renames the column is caught here rather than by a launcher that stops seeing recordings.
    assert.match(browseSql(NONE).sql, /m\.replay_key, m\.replay_uploaded_at, m\.replay_size_bytes/);
});
