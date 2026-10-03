/**
 * The season calendar and the soft reset. Run: `npm test`.
 *
 * <p>Pinned because a mistake here moves nobody's rating today and EVERYBODY's on the night it
 * matters: a boundary an hour off files the last matches of a season into the next one, and a
 * text bound in the wrong format sorts every match of the boundary day into the wrong season
 * without an error anywhere.</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SEASON_2_START, seasonAt, seasonBounds, currentSeason, isClosed, seasonOfCreatedAt,
    boundsAsSql, seasonPredicate, softReset, seasonList, seasonStartMs, toSqliteText,
    SOFT_RESET_MIN_RD,
} from './seasons';
import { pickEffective } from './glicko2';

const at = (iso: string) => Date.parse(iso);

test('Season 2 starts on 1 December 2026 at 06:00 UTC — midnight in Central America', () => {
    assert.equal(new Date(SEASON_2_START).toISOString(), '2026-12-01T06:00:00.000Z');
});

test('THE BOUNDARY, to the second, in both forms a timestamp arrives in', () => {
    assert.equal(seasonAt(at('2026-12-01T05:59:59Z')), 1);
    assert.equal(seasonAt(at('2026-12-01T06:00:00Z')), 2);
    // SQLite's own form: `datetime('now')` text, UTC with no zone marker.
    assert.equal(seasonOfCreatedAt('2026-12-01 05:59:59'), 1);
    assert.equal(seasonOfCreatedAt('2026-12-01 06:00:00'), 2);
    // ISO passes through too.
    assert.equal(seasonOfCreatedAt('2026-12-01T06:00:00.000Z'), 2);
});

test('the 1st of a boundary month BEFORE 06:00 still belongs to the season that is ending', () => {
    assert.equal(seasonAt(at('2027-03-01T05:00:00Z')), 2);
    assert.equal(seasonAt(at('2027-03-01T06:00:00Z')), 3);
});

test('three calendar months each: Dec-Feb, Mar-May, Jun-Aug, Sep-Nov', () => {
    assert.equal(new Date(seasonStartMs(3)).toISOString(), '2027-03-01T06:00:00.000Z');
    assert.equal(new Date(seasonStartMs(4)).toISOString(), '2027-06-01T06:00:00.000Z');
    assert.equal(new Date(seasonStartMs(5)).toISOString(), '2027-09-01T06:00:00.000Z');
    // The year rolls over without anybody's help.
    assert.equal(new Date(seasonStartMs(6)).toISOString(), '2027-12-01T06:00:00.000Z');
    assert.equal(new Date(seasonStartMs(7)).toISOString(), '2028-03-01T06:00:00.000Z');
    assert.equal(seasonAt(at('2028-02-29T12:00:00Z')), 6);
});

test('seasons are contiguous: every season ends exactly where the next one starts', () => {
    for (let n = 1; n < 20; n++) {
        assert.equal(seasonBounds(n).end, seasonStartMs(n + 1), `season ${n}`);
        // And an instant one millisecond either side of the boundary lands on its own side.
        const b = seasonBounds(n).end;
        assert.equal(seasonAt(b - 1), n);
        assert.equal(seasonAt(b), n + 1);
    }
});

test('Season 1 has no beginning: everything ever stored before the boundary is in it', () => {
    assert.equal(seasonBounds(1).start, null);
    assert.equal(seasonAt(at('2020-01-01T00:00:00Z')), 1);
    assert.equal(seasonAt(0), 1);
});

test('a timestamp that cannot be read lands in Season 1, never in the running one', () => {
    assert.equal(seasonOfCreatedAt(null), 1);
    assert.equal(seasonOfCreatedAt(''), 1);
    assert.equal(seasonOfCreatedAt('not a date'), 1);
});

test('a season is closed from its boundary on — no grace', () => {
    assert.equal(isClosed(1, at('2026-12-01T05:59:59Z')), false);
    assert.equal(isClosed(1, at('2026-12-01T06:00:00Z')), true);
    assert.equal(isClosed(2, at('2026-12-01T06:00:00Z')), false);
    assert.equal(currentSeason(at('2026-10-01T00:00:00Z')), 1);
});

test('THE TEXT BOUNDS ARE IN SQLITE\'S OWN FORM — an ISO "T" would misfile the boundary day', () => {
    // Compared as text against matches.created_at, which datetime('now') writes with a space.
    // 'T' sorts after ' ', so an ISO bound would put every match of 1 December, whatever its
    // time, on the far side of it.
    assert.deepEqual(boundsAsSql(2), { start: '2026-12-01 06:00:00', end: '2027-03-01 06:00:00' });
    assert.deepEqual(boundsAsSql(1), { start: null, end: '2026-12-01 06:00:00' });
    assert.equal(toSqliteText(SEASON_2_START), '2026-12-01 06:00:00');
    assert.ok('2026-12-01 05:59:59' < boundsAsSql(2).start!);
    assert.ok('2026-12-01 06:00:00' >= boundsAsSql(2).start!);
});

test('the season predicate binds what it names', () => {
    const one = seasonPredicate(1, 'm.created_at');
    assert.equal(one.sql, 'm.created_at < ?');
    assert.deepEqual(one.args, ['2026-12-01 06:00:00']);
    const two = seasonPredicate(2, 'm.created_at');
    assert.equal(two.sql, 'm.created_at >= ? AND m.created_at < ?');
    assert.equal(two.args.length, 2);
});

test('the soft reset keeps half the distance to 1500 and at least 250 of deviation', () => {
    assert.deepEqual(softReset({ rating: 2000, rd: 80, volatility: 0.06 }),
        { rating: 1750, rd: 250, volatility: 0.06 });
    assert.deepEqual(softReset({ rating: 1300, rd: 320, volatility: 0.05 }),
        { rating: 1400, rd: 320, volatility: 0.05 });
    assert.equal(softReset({ rating: 1500, rd: 10, volatility: 0.06 }).rd, SOFT_RESET_MIN_RD);
});

test('the list names every season so far, the running one open', () => {
    const list = seasonList(at('2027-04-01T00:00:00Z'));
    assert.deepEqual(list.map((s) => [s.n, s.closed]), [[1, true], [2, true], [3, false]]);
    assert.equal(list[0]!.starts_at, null);
    assert.equal(list[2]!.ends_at, '2027-06-01T06:00:00.000Z');
});

// ---------------------------------------------------------------- the effective rating

const row = (user_id: string, season: number, rating: number, rd: number, games_played: number) =>
    ({ user_id, season, rating, rd, volatility: 0.06, games_played });

test('THE ONE THAT MATTERS: a new season starts from the soft reset of the last one played', () => {
    const eff = pickEffective([row('a', 1, 2000, 80, 12)], 2, ['a']);
    assert.deepEqual(eff.get('a'), {
        rating: 1750, rd: 250, volatility: 0.06, games_played: 0, source: 'carried',
    });
});

test('the season\'s own row wins once there is one', () => {
    const eff = pickEffective([row('a', 1, 2000, 80, 12), row('a', 2, 1780, 240, 1)], 2, ['a']);
    assert.equal(eff.get('a')!.source, 'season');
    assert.equal(eff.get('a')!.rating, 1780);
    assert.equal(eff.get('a')!.games_played, 1);
});

test('a skipped season carries once, from the last season actually played', () => {
    // Played in 1, nothing in 2, back in 3: one halving, not two.
    const eff = pickEffective([row('a', 1, 2000, 80, 12)], 3, ['a']);
    assert.equal(eff.get('a')!.rating, 1750);
    // And the most recent played season wins over an older one.
    const two = pickEffective([row('b', 1, 2000, 80, 12), row('b', 2, 1600, 200, 3)], 3, ['b']);
    assert.equal(two.get('b')!.rating, 1550);
});

test('a row with no games carries nothing', () => {
    const eff = pickEffective([row('a', 1, 1900, 120, 0)], 2, ['a']);
    assert.equal(eff.get('a')!.source, 'default');
    assert.equal(eff.get('a')!.rating, 1500);
});

test('a later season never leaks backwards, and everybody asked gets an answer', () => {
    const eff = pickEffective([row('a', 3, 1900, 100, 4)], 2, ['a', 'nobody']);
    assert.equal(eff.get('a')!.source, 'default');
    assert.equal(eff.get('nobody')!.source, 'default');
    assert.equal(eff.get('nobody')!.rd, 350);
});
