/**
 * 1v1 against team, in the statistics queries. Run: `npm test`.
 *
 * Same split as `listing.test.ts`: no database harness, so what is pinned is the SQL the
 * decision is written in.
 *
 * Two rules carry this file, and both are the kind that fail silently:
 *
 *  1. **NULL is 1v1 and only 1v1.** `rating_mode` is null on every match stored before
 *     migration 0010, and those were all 1v1. Folding NULL into the team branch would count
 *     the entire pre-team history as team games.
 *
 *  2. **The team predicate belongs to team mode only.** Those same pre-0010 rows carry
 *     `team = 0` for everybody, so `b.team <> a.team` is FALSE on all of them. Applied to
 *     1v1 it reads like a no-op and empties the matchup table of its whole history. That is
 *     not hypothetical: it was written that way first and this file caught it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MATCHUPS_SQL, matchupsSql, topMapsSql } from './rest';

// ---------------------------------------------------------------- the mode predicate

test('THE ONE THAT MATTERS: a null rating_mode counts as 1v1 and never as team', () => {
    const solo = matchupsSql(null, 'default');
    const team = matchupsSql(null, 'team');

    assert.match(solo, /m\.rating_mode IS NULL OR m\.rating_mode = 'default'/);
    // The team branch must NOT mention NULL at all.
    assert.match(team, /m\.rating_mode = 'team'/);
    assert.equal(/rating_mode IS NULL/.test(team), false,
        'a null rating_mode is a pre-2v2 1v1, not a team game');
});

test('THE OTHER ONE: the team predicate is absent from the 1v1 query', () => {
    // Every match stored before the team column carries team 0 for BOTH players, so this
    // predicate would be false on all of them and the 1v1 matchup table would lose its
    // history. In a 1v1 the two players are opponents by definition; nothing needs proving.
    const solo = matchupsSql(null, 'default');
    assert.equal(solo.includes('b.team'), false);

    const team = matchupsSql(null, 'team');
    assert.match(team, /b\.team <> a\.team/);
});

test('allies and rivals differ by one operator and nothing else', () => {
    // They answer the two questions a team format raises and must agree on everything else,
    // or "played with" and "played against" would not be comparable.
    const rivals = matchupsSql(null, 'team', 'rivals');
    const allies = matchupsSql(null, 'team', 'allies');

    assert.match(rivals, /b\.team <> a\.team/);
    assert.match(allies, /b\.team = a\.team/);
    assert.equal(
        rivals.replace('b.team <> a.team', 'X'),
        allies.replace('b.team = a.team', 'X'));
});

test('the pair query keeps its self-join guards in every mode and side', () => {
    // `a.civ < b.civ` drops the mirror of each pair AND stops a civilization facing itself;
    // `b.user_id <> a.user_id` stops a player being joined to themselves. Both survive the
    // splicing that adds the team predicate.
    for (const mode of ['default', 'team'] as const) {
        for (const side of ['rivals', 'allies'] as const) {
            const sql = matchupsSql(null, mode, side);
            assert.match(sql, /a\.civ < b\.civ/, `${mode}/${side}`);
            assert.match(sql, /b\.user_id <> a\.user_id/, `${mode}/${side}`);
            assert.match(sql, /GROUP BY m\.mod_id, m\.mod_combined_hash/, `${mode}/${side}`);
        }
    }
});

test('the default arguments reproduce the query as it was', () => {
    // A launcher that never sends ?mode= must get exactly what it got before this existed.
    assert.equal(matchupsSql(null), MATCHUPS_SQL);
    assert.equal(matchupsSql(null, 'default', 'rivals'), MATCHUPS_SQL);
});

// ---------------------------------------------------------------- maps

test('the map query takes the mode without losing its window or its tiebreak', () => {
    const team = topMapsSql(null, 'team');
    assert.match(team, /m\.rating_mode = 'team'/);
    assert.match(team, /created_at >= datetime\('now', \?\)/);
    assert.match(team, /ORDER BY n DESC, map_name ASC/);
});

test('the map query without a mode is byte-identical to the unscoped one', () => {
    // The mode is optional here on purpose: /stats/community serves the 1v1 page by default
    // and an older launcher asks for nothing.
    assert.equal(topMapsSql(null, null), topMapsSql(null));
    assert.equal(topMapsSql('wol', null), topMapsSql('wol'));
});

test('a mod and a mode compose, and each keeps its own placeholder', () => {
    // The bindings are positional: window, then mod. A mode is literal text and binds
    // nothing, so adding it must not shift the mod's placeholder.
    const sql = topMapsSql('wol', 'team');
    assert.match(sql, /AND mod_id = \?/);
    assert.match(sql, /m\.rating_mode = 'team'/);
    // Window, mod, limit — in that order, and no fourth.
    assert.equal((sql.match(/\?/g) ?? []).length, 3);
});
