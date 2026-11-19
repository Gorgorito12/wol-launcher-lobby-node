/**
 * The public table lists active players only (2026-11-18), against SQLite in memory built from the
 * migrations. The point: a place, the table's size and the list agree about who is on it; an
 * inactive player is ABSENT (no badge), never 0 (the lowest badge); the kill switch brings
 * everybody back; and one rated match puts him back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db';
import type { AppContext } from '../context';
import { ladderRanks, ladderSize, inactiveHiddenCount, ladderRatingAt } from './rest';
import { configureLadderActivity, resetLadderActivityForTests, isOffTable } from './ladderActivity';
import { hasTeamPlace } from '../users/badgeMode';

function freshCtx(): AppContext {
    const db = new Db(':memory:');
    db.migrate('migrations');
    const raw = db.raw();
    const rows: Array<[string, number, number]> = [
        // id, rating, days since the last rated match
        ['active1', 1700, 1], ['active2', 1600, 10], ['idle', 1650, 45], ['active3', 1500, 29],
    ];
    for (const [id, rating, days] of rows) {
        raw.prepare(`INSERT INTO users (id, discord_id, discord_username, display_name) VALUES (?, ?, ?, ?)`)
            .run(id, `dc-${id}`, id, id);
        raw.prepare(
            `INSERT INTO player_ratings (user_id, mode, rating, rd, games_played, last_rated_at)
             VALUES (?, 'default', ?, 60, 20, datetime('now', ?))`,
        ).run(id, rating, `-${days} days`);
    }
    // A team player placed and idle, for the team-badge selector.
    raw.prepare(
        `INSERT INTO player_ratings (user_id, mode, rating, rd, games_played, last_rated_at)
         VALUES ('idle', 'team', 1550, 60, 8, datetime('now', '-60 days'))`,
    ).run();
    return { db } as unknown as AppContext;
}

test('THE ONE THAT MATTERS: an inactive player is absent from the table, never the lowest badge', async () => {
    resetLadderActivityForTests();
    const ctx = freshCtx();
    const ranks = await ladderRanks(ctx, ['active1', 'active2', 'idle', 'active3'], 'default');
    assert.equal(ranks.get('active1'), 1);
    assert.equal(ranks.get('active2'), 2); // idle (1650) would have been 2nd
    assert.equal(ranks.get('active3'), 3);
    assert.equal(ranks.has('idle'), false);
    assert.equal(await ladderSize(ctx, 'default'), 3);
    assert.equal(await inactiveHiddenCount(ctx, 'default'), 1);
    assert.equal(await ladderRatingAt(ctx, 'default', 2), 1600);
    // The team-badge selector asks the same question as the team table.
    assert.equal(await hasTeamPlace(ctx, 'idle'), false);
});

test('the kill switch brings everybody back at once', async () => {
    configureLadderActivity({ hide: false });
    try {
        const ctx = freshCtx();
        const ranks = await ladderRanks(ctx, ['idle'], 'default');
        assert.equal(ranks.get('idle'), 2);
        assert.equal(await ladderSize(ctx, 'default'), 4);
        assert.equal(await inactiveHiddenCount(ctx, 'default'), 0);
    } finally {
        resetLadderActivityForTests();
    }
});

test('the days are a setting, per ladder', async () => {
    configureLadderActivity({ days: 60 });
    try {
        const ctx = freshCtx();
        assert.equal((await ladderRanks(ctx, ['idle'], 'default')).get('idle'), 2);
    } finally {
        resetLadderActivityForTests();
    }
});

test('one rated match puts him back', async () => {
    resetLadderActivityForTests();
    const ctx = freshCtx();
    (ctx.db as Db).raw().prepare(
        `UPDATE player_ratings SET last_rated_at = datetime('now') WHERE user_id = 'idle'`,
    ).run();
    assert.equal((await ladderRanks(ctx, ['idle'], 'default')).get('idle'), 2);
});

test('a player below the entry bar is still 0, not absent', async () => {
    resetLadderActivityForTests();
    const ctx = freshCtx();
    (ctx.db as Db).raw().prepare(`INSERT INTO users (id, discord_id, discord_username, display_name) VALUES ('new', 'dc-new', 'new', 'new')`).run();
    assert.equal((await ladderRanks(ctx, ['new'], 'default')).get('new'), 0);
});

test('off the table is decided on the same days', () => {
    resetLadderActivityForTests();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    assert.equal(isOffTable(now - 31 * day, now, 'default'), true);
    assert.equal(isOffTable(now - 29 * day, now, 'default'), false);
    assert.equal(isOffTable(null, now, 'default'), false);
});
