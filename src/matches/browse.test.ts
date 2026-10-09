import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../lib/errors';
import {
    BROWSE_DEFAULT_LIMIT, BROWSE_MAX_LIMIT, browseCountSql, browseSql, decodeCursor, encodeCursor,
    likePattern, parseBrowseQuery, type BrowseFilters,
} from './browse';

const NONE: BrowseFilters = {
    limit: 30, cursor: null, q: null, replayOnly: false, mod: null,
    sort: 'newest', days: null, kind: null, decided: false,
};

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
        ...NONE,
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

test('an oldest-first cursor carries its direction and is refused by the other order', () => {
    const asc = encodeCursor('2026-10-09 18:00:00', 'abc-123', true);
    assert.deepEqual(decodeCursor(asc, true), { createdAt: '2026-10-09 18:00:00', id: 'abc-123' });
    const isBadCursor = (e: unknown) => e instanceof HttpError && e.status === 400 && e.code === 'bad_cursor';
    // The same position read the other way would skip or repeat matches.
    assert.throws(() => decodeCursor(asc, false), isBadCursor);
    assert.throws(() => decodeCursor(encodeCursor('2026-10-09 18:00:00', 'abc-123'), true), isBadCursor);
    assert.throws(() => decodeCursor(Buffer.from('2026-10-09 18:00:00|abc|desc', 'utf8').toString('base64url'), true), isBadCursor);
    // A cursor issued before sorting existed is a newest-first one and still works.
    assert.deepEqual(decodeCursor(Buffer.from('2026-10-09 18:00:00|abc', 'utf8').toString('base64url')),
        { createdAt: '2026-10-09 18:00:00', id: 'abc' });
});

test('the new filters accept only their fixed values and fall back otherwise', () => {
    assert.equal(parseBrowseQuery({ sort: 'oldest' }).sort, 'oldest');
    assert.equal(parseBrowseQuery({ sort: 'longest' }).sort, 'newest');
    assert.equal(parseBrowseQuery({ days: '7' }).days, 7);
    assert.equal(parseBrowseQuery({ days: '30' }).days, 30);
    assert.equal(parseBrowseQuery({ days: '1' }).days, 1);
    assert.equal(parseBrowseQuery({ days: '3' }).days, null);
    assert.equal(parseBrowseQuery({ days: 'x' }).days, null);
    assert.equal(parseBrowseQuery({ kind: 'competitive' }).kind, 'competitive');
    assert.equal(parseBrowseQuery({ kind: 'casual' }).kind, 'casual');
    assert.equal(parseBrowseQuery({ kind: 'ranked' }).kind, null);
    assert.equal(parseBrowseQuery({ decided: '1' }).decided, true);
    assert.equal(parseBrowseQuery({ decided: '0' }).decided, false);
    // The cursor is read for the order it is sent with.
    const asc = encodeCursor('2026-10-09 18:00:00', 'm9', true);
    assert.deepEqual(parseBrowseQuery({ sort: 'oldest', cursor: asc }).cursor, { createdAt: '2026-10-09 18:00:00', id: 'm9' });
    assert.throws(() => parseBrowseQuery({ cursor: asc }), (e: unknown) => e instanceof HttpError && e.code === 'bad_cursor');
});

test('oldest first reverses the order and the cursor comparison', () => {
    const f: BrowseFilters = { ...NONE, sort: 'oldest', cursor: { createdAt: '2026-10-09 18:00:00', id: 'm9' } };
    const { sql } = browseSql(f);
    assert.match(sql, /ORDER BY m\.created_at ASC, m\.id ASC/);
    assert.match(sql, /\(m\.created_at > \? OR \(m\.created_at = \? AND m\.id > \?\)\)/);
});

test('kind, period and decided add their clauses; an unknown room is in neither kind', () => {
    const comp = browseSql({ ...NONE, kind: 'competitive' });
    assert.match(comp.sql, /l\.competitive = 1/);
    const cas = browseSql({ ...NONE, kind: 'casual' });
    assert.match(cas.sql, /l\.competitive = 0/);
    assert.doesNotMatch(cas.sql, /COALESCE|IS NULL/, 'a match whose lobby is gone must not count as casual');

    const week = browseSql({ ...NONE, days: 7 });
    assert.match(week.sql, /m\.created_at >= datetime\('now', \?\)/);
    assert.deepEqual(week.params, ['-7 days', 31]);

    const won = browseSql({ ...NONE, decided: true });
    assert.match(won.sql, /EXISTS \(SELECT 1 FROM match_participants p\s+WHERE p\.match_id = m\.id AND p\.result = 1\.0\)/);
});

test('the count joins the lobby only when the kind needs it, and filters like the page', () => {
    const plain = browseCountSql({ ...NONE, days: 30, decided: true });
    assert.doesNotMatch(plain.sql, /JOIN lobbies/);
    assert.deepEqual(plain.params, ['-30 days']);
    const kind = browseCountSql({ ...NONE, kind: 'competitive', cursor: { createdAt: '2026-10-09 18:00:00', id: 'm9' } });
    assert.match(kind.sql, /^SELECT COUNT\(\*\) AS n FROM matches m LEFT JOIN lobbies l ON l\.id = m\.lobby_id WHERE l\.competitive = 1$/);
    assert.deepEqual(kind.params, []);
});
