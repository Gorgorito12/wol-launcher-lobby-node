/**
 * Co-organisers: who a tournament's owner may let help run it. Run: `npm test`.
 *
 * Same split as `listing.test.ts`: there is no database harness in this repo, so what is
 * pinned here is the SQL the decision is written in.
 *
 * The bug this guards is a privilege one, which is the worst kind to find late. Three
 * things have to stay true and none of them is visible from a screenshot:
 *
 *   1. The grant is scoped to ONE tournament. A statement that forgot `tournament_id`
 *      would make a co-organiser of one bracket a co-organiser of every bracket.
 *   2. Removing is bounded the same way, or revoking somebody from one tournament would
 *      revoke them from all of them.
 *   3. The guard reads the tournament row BEFORE the manager row, so a mistyped id stays a
 *      404 and never becomes "somebody else's tournament".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const STORE = readFileSync('src/tournaments/store.ts', 'utf8');
const AUTH = readFileSync('src/middleware/auth.ts', 'utf8');
const REST = readFileSync('src/tournaments/rest.ts', 'utf8');
const MIGRATION = readFileSync('migrations/0016_tournament_managers.sql', 'utf8');

// ---------------------------------------------------------------- the grant is per tournament

test('THE ONE THAT MATTERS: every manager statement is scoped to one tournament', () => {
    // Each of the four touches tournament_managers, and each must name the tournament.
    // Without it, a grant is global and a revoke is a purge.
    for (const fn of ['isManager', 'listManagers', 'insertManager', 'deleteManager']) {
        const start = STORE.indexOf(`export async function ${fn}(`);
        assert.ok(start > 0, `${fn} is gone`);
        const body = STORE.slice(start, start + 900);
        assert.match(body, /tournament_managers/, `${fn} stopped using the table`);
        assert.match(
            body,
            /tournament_id\s*=\s*\?/,
            `${fn} must bind tournament_id, or the grant leaves its tournament`,
        );
    }
});

test('appointing is idempotent and revoking reports whether there was anything to revoke', () => {
    const insert = STORE.slice(STORE.indexOf('export async function insertManager('));
    assert.match(insert.slice(0, 700), /INSERT OR IGNORE INTO tournament_managers/);

    const del = STORE.slice(STORE.indexOf('export async function deleteManager('));
    assert.match(del.slice(0, 500), /r\.changes > 0/,
        'a revoke that always says ok cannot tell the owner they picked the wrong person');
});

test('appointing stamps activity, or an organised tournament goes stale while being organised', () => {
    const insert = STORE.slice(
        STORE.indexOf('export async function insertManager('),
        STORE.indexOf('export async function deleteManager('),
    );
    assert.match(insert, /last_activity_at = datetime\('now'\)/);
});

// ---------------------------------------------------------------- the guard

test('THE ONE THAT MATTERS: the guard answers 404 before it answers 403', () => {
    const guard = AUTH.slice(AUTH.indexOf('export function requireTournamentManager('));
    const notFound = guard.indexOf("Errors.NotFound('Tournament')");
    const forbidden = guard.indexOf('Errors.Forbidden()');

    assert.ok(notFound > 0 && forbidden > 0, 'the guard lost one of its two refusals');
    assert.ok(
        notFound < forbidden,
        'a mistyped id must read as "no such tournament", never as "somebody else\'s"',
    );
});

test('the guard fails CLOSED: it grants, so it must not swallow a database error', () => {
    const guard = AUTH.slice(
        AUTH.indexOf('export function requireTournamentManager('),
    );
    const body = guard.slice(0, guard.indexOf('\n}\n') + 1);
    assert.equal(
        /try\s*{/.test(body),
        false,
        'a try/catch here would turn an unreadable database into a granted permission',
    );
});

test('the guard reads two rows rather than one join, which is what keeps 404 separate', () => {
    const guard = AUTH.slice(AUTH.indexOf('export function requireTournamentManager('));
    const body = guard.slice(0, 1800);
    assert.match(body, /FROM tournaments WHERE id = \?/);
    assert.match(body, /FROM tournament_managers WHERE tournament_id = \? AND user_id = \?/);
    assert.equal(/JOIN/.test(body), false,
        'a join would collapse "no such tournament" into "not allowed"');
});

// ---------------------------------------------------------------- what stays the owner's

test('THE ONE THAT MATTERS: cancelling and appointing are never delegated', () => {
    for (const route of [
        "app.post('/tournaments/:id/cancel', {",
        "app.post('/tournaments/:id/managers', {",
        "app.post('/tournaments/:id/managers/:uid/remove', {",
    ]) {
        const at = REST.indexOf(route);
        assert.ok(at > 0, `${route} is gone`);
        const guard = REST.slice(at, at + 220);
        assert.match(guard, /requireTournamentOwner\(ctx\)/,
            `${route} must stay the owner's: a co-organiser who appoints co-organisers can be `
            + 'talked into handing the tournament around');
        assert.equal(/requireTournamentManager/.test(guard), false, route);
    }
});

test('the routes that run a bracket did widen, so the feature is not inert', () => {
    for (const route of [
        "app.post('/tournaments/:id/open', {",
        "app.post('/tournaments/:id/close', {",
        "app.post('/tournaments/:id/entrants/:eid/accept', {",
        "app.post('/tournaments/:id/seed', {",
        "app.post('/tournaments/:id/start', {",
        "app.post('/tournaments/:id/matches/:mid/walkover', {",
        "app.post('/tournaments/:id/entrants/:eid/disqualify', {",
    ]) {
        const at = REST.indexOf(route);
        assert.ok(at > 0, `${route} is gone`);
        assert.match(REST.slice(at, at + 220), /requireTournamentManager\(ctx\)/, route);
    }
});

test('a grant dies with its tournament', () => {
    assert.match(MIGRATION, /REFERENCES tournaments\(id\) ON DELETE CASCADE/);
    assert.match(MIGRATION, /PRIMARY KEY \(tournament_id, user_id\)/);
});

test('the detail carries managers as ids AND names', () => {
    // Ids are what a permission check reads; names are the only thing a list can draw.
    assert.match(REST, /manager_user_ids: managers\.map\(\(m\) => m\.user_id\)/);
    assert.match(REST, /\n\s+managers,\n/);
});
