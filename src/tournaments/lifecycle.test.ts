/**
 * When a tournament stops counting as alive. Run: `npm test`.
 *
 * Same split as `ladder.test.ts`: there is no database harness in this repo, so what is
 * pinned here is the DECISION, plus the structural agreement between the TypeScript
 * predicate and its SQL twin. The two running over identical rows is checked against a
 * real database on deploy (see DEPLOY.md), because that is the only place it can be.
 *
 * The failure this guards is quiet and slow: if `isStale` and `aliveWhereClause` drift,
 * the public list and the creation caps disagree about which tournaments exist, and the
 * symptom is somebody being told they already own two tournaments while seeing one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    isStale, isTerminal, aliveWhereClause, staleWhereClause,
    DRAFT_STALE_DAYS, LIVE_STALE_DAYS, TERMINAL_STATUSES, CAPPED_STATUSES,
    type TournamentStatus,
} from './lifecycle';

const NOW = Date.parse('2026-09-02T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** A SQLite-shaped timestamp N days before NOW — no zone marker, like the real ones. */
function daysAgo(n: number): string {
    return new Date(NOW - n * DAY).toISOString().replace('T', ' ').slice(0, 19);
}

function row(status: TournamentStatus, ageDays: number, activityDays = ageDays) {
    return { status, createdAt: daysAgo(ageDays), lastActivityAt: daysAgo(activityDays) };
}

// ---------------------------------------------------------------- the decision

test('a draft nobody ever opened dies after a week', () => {
    assert.equal(isStale(row('draft', DRAFT_STALE_DAYS - 1), NOW), false);
    assert.equal(isStale(row('draft', DRAFT_STALE_DAYS + 1), NOW), true);
});

test('a live tournament survives a month of silence, and not two', () => {
    for (const s of ['registration', 'ready', 'running'] as const) {
        assert.equal(isStale(row(s, 90, LIVE_STALE_DAYS - 1), NOW), false, `${s} at 29 days`);
        assert.equal(isStale(row(s, 90, LIVE_STALE_DAYS + 1), NOW), true, `${s} at 31 days`);
    }
});

test('activity is what counts, not age — one registration resets the clock', () => {
    // Created six months ago, but somebody signed up yesterday.
    assert.equal(isStale(row('running', 180, 1), NOW), false);
});

test('a draft is aged on CREATION, so a stray touch cannot keep it alive forever', () => {
    // last_activity_at is fresh, but nobody ever opened it for registration.
    assert.equal(isStale({ status: 'draft', createdAt: daysAgo(60), lastActivityAt: daysAgo(0) }, NOW), true);
});

test('THE ONE THAT MATTERS: a finished tournament never goes stale, however old', () => {
    // History is cheap and archiving one would overwrite why it actually ended.
    for (const s of TERMINAL_STATUSES) {
        assert.equal(isStale(row(s, 3650), NOW), false, s);
        assert.equal(isTerminal(s), true, s);
    }
    for (const s of ['draft', 'registration', 'ready', 'running'] as const) {
        assert.equal(isTerminal(s), false, s);
    }
});

test('an undateable row is stale, not immortal', () => {
    // Treating an unparseable timestamp as fresh is how a row sits there for ever, which
    // is the exact failure this module exists to prevent.
    assert.equal(isStale({ status: 'running', createdAt: '', lastActivityAt: null }, NOW), true);
    assert.equal(isStale({ status: 'running', createdAt: 'not a date', lastActivityAt: 'nor this' }, NOW), true);
});

test('a missing last_activity_at falls back to creation rather than to now', () => {
    assert.equal(isStale({ status: 'running', createdAt: daysAgo(60), lastActivityAt: null }, NOW), true);
    assert.equal(isStale({ status: 'running', createdAt: daysAgo(2), lastActivityAt: null }, NOW), false);
});

test('the boundary is exclusive, so a tournament is not archived on its anniversary', () => {
    const exactly = { status: 'running' as const, createdAt: daysAgo(90), lastActivityAt: daysAgo(LIVE_STALE_DAYS) };
    assert.equal(isStale(exactly, NOW), false, 'exactly 30 days is still alive');
});

test('only the live statuses cost the owner a slot', () => {
    assert.deepEqual([...CAPPED_STATUSES], ['draft', 'registration', 'ready', 'running']);
    for (const s of TERMINAL_STATUSES) {
        assert.equal(CAPPED_STATUSES.includes(s), false, `${s} must not count against the cap`);
    }
});

// ---------------------------------------------------------------- the SQL twin

test('both clauses are built from the same two constants', () => {
    // A drift here is the whole bug: the list would hide what the cap still counts.
    for (const sql of [aliveWhereClause(), staleWhereClause()]) {
        assert.match(sql, new RegExp(`<?=?\\s*${DRAFT_STALE_DAYS}\\b`));
        assert.match(sql, new RegExp(`<?=?\\s*${LIVE_STALE_DAYS}\\b`));
    }
});

test('both clauses age a draft on created_at and everything else on last_activity_at', () => {
    for (const sql of [aliveWhereClause(), staleWhereClause()]) {
        assert.match(sql, /status\s*=\s*'draft'[\s\S]*julianday\(created_at\)/);
        assert.match(sql, /COALESCE\(last_activity_at, created_at\)/,
            'the SQL must fall back the same way isStale does');
    }
});

test('the alive clause lets terminal rows through and the stale clause excludes them', () => {
    assert.match(aliveWhereClause(), /status IN \('finished','cancelled','abandoned'\)/);
    assert.match(staleWhereClause(), /status NOT IN \('finished','cancelled','abandoned'\)/);
});

test('an alias is applied to every column, or the clause breaks the moment it is joined', () => {
    const sql = aliveWhereClause('t');
    assert.match(sql, /t\.status/);
    assert.match(sql, /t\.created_at/);
    assert.match(sql, /t\.last_activity_at/);
    // No bare column may survive: a bare `status` in a join is either ambiguous or wrong.
    assert.equal(/[^.\w]status\b/.test(sql.replace(/t\.status/g, 'X')), false);
    assert.equal(/[^.\w]created_at\b/.test(sql.replace(/t\.created_at/g, 'X')), false);
    assert.equal(/[^.\w]last_activity_at\b/.test(sql.replace(/t\.last_activity_at/g, 'X')), false);
});

test('julianday is used rather than a bound clock', () => {
    // Every timestamp in this database is written by SQLite's own datetime('now'), so the
    // comparison has to be made by the same clock or the two disagree by the host offset.
    for (const sql of [aliveWhereClause(), staleWhereClause()]) {
        assert.match(sql, /julianday\('now'\)/);
    }
});
