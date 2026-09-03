/**
 * Which tournaments the public list shows. Run: `npm test`.
 *
 * Same split as `ladder.test.ts`: there is no database harness in this repo, so what is
 * pinned here is the SQL fragment the decision is written in. The fragment actually
 * selecting the same rows as `isStale` is checked against a real database on deploy.
 *
 * The bug this guards is quiet. `TOURNAMENT_LIST_WHERE` and the two creation caps in
 * `store.ts` all filter on `aliveWhereClause`; if the list ever stops sharing it, a
 * forgotten tournament disappears from view while still counting against its owner's
 * limit, and the owner is told they have two tournaments while seeing one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOURNAMENT_LIST_WHERE, LIST_COLUMNS } from './store';
import { aliveWhereClause, DRAFT_STALE_DAYS, LIVE_STALE_DAYS } from './lifecycle';

test('the list hides drafts', () => {
    // A draft is invisible until its owner opens registration. The owner sees their own
    // through `listOwnDrafts`, which is a separate query on purpose.
    assert.match(TOURNAMENT_LIST_WHERE, /status\s*<>\s*'draft'/);
});

test('THE ONE THAT MATTERS: the list is built from the same alive rule as the caps', () => {
    // Not "contains something similar" — literally the same generated string, so the two
    // cannot drift without this failing.
    assert.ok(
        TOURNAMENT_LIST_WHERE.includes(aliveWhereClause('t')),
        'the list must embed aliveWhereClause verbatim, not a copy of it',
    );
});

test('the fragment is aliased throughout, or it breaks the moment it is joined', () => {
    assert.match(TOURNAMENT_LIST_WHERE, /t\.status/);
    // No bare column may survive: in a join a bare `status` is ambiguous or wrong.
    const masked = TOURNAMENT_LIST_WHERE
        .replace(/t\.status/g, 'X').replace(/t\.created_at/g, 'X').replace(/t\.last_activity_at/g, 'X');
    assert.equal(/[^.\w]status\b/.test(masked), false);
    assert.equal(/[^.\w]created_at\b/.test(masked), false);
    assert.equal(/[^.\w]last_activity_at\b/.test(masked), false);
});

test('it starts as a WHERE clause, so callers can append to it', () => {
    assert.match(TOURNAMENT_LIST_WHERE, /^WHERE\s/);
});

test('both staleness horizons reach the list', () => {
    // They arrive through aliveWhereClause rather than being restated, which is the point,
    // but a reader of the list query should still be able to see them.
    assert.ok(TOURNAMENT_LIST_WHERE.includes(String(DRAFT_STALE_DAYS)));
    assert.ok(TOURNAMENT_LIST_WHERE.includes(String(LIVE_STALE_DAYS)));
});

test('a finished tournament is not filtered out by the list rule itself', () => {
    // Terminal rows are alive-by-definition in `aliveWhereClause`, so the only thing
    // keeping them out of a listing would be an explicit status filter — and there is
    // none beyond the draft one. History stays visible.
    assert.match(TOURNAMENT_LIST_WHERE, /status IN \('finished','cancelled','abandoned'\)/);
});

// ---------------------------------------------------------------- what a row carries

test('the list counts applications separately from entrants', () => {
    // `entrant_count` lumps pending, confirmed and waitlisted together, so it cannot answer
    // "does this tournament need a decision from me". The launcher's list row says
    // "2 requests" from this second count, and without it somebody has to open every
    // tournament they own to find out whether anybody is waiting.
    assert.match(LIST_COLUMNS, /AS pending_count/);
    assert.match(LIST_COLUMNS, /e\.status\s*=\s*'pending'\)\s*AS pending_count/);
});

test('the two counts are different questions and stay different', () => {
    // The trap is copying the entrant filter into the new count: 'pending' is ONE of the
    // three statuses entrant_count accepts, so a copy would make the two columns equal
    // for a tournament in approval mode and nobody would notice until a row claimed every
    // entrant was an application.
    const entrant = /AND e\.status IN \('pending','confirmed','waitlist'\)\) AS entrant_count/;
    assert.match(LIST_COLUMNS, entrant);
    assert.equal(
        LIST_COLUMNS.match(/AS pending_count/g)?.length, 1,
        'pending_count is selected exactly once',
    );
});

test('the counts are properties of the tournament, not of the viewer', () => {
    // /tournaments is served from ONE memo shared by every caller. A column that depended
    // on who asked would be cached and then served to the wrong person, which is why
    // "it is your turn to play" is NOT in this list and lives on the open tournament
    // instead. Nothing here may bind a user id.
    assert.equal(LIST_COLUMNS.includes('?'), false,
        'a bound parameter here would mean a per-viewer column in a shared memo');
});
