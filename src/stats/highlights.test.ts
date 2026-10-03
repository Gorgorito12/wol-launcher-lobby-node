/** Monthly highlights and the Discord message. Run: `npm test`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHighlights, monthBounds, monthOf, previousMonth, renderDiscord, type HighlightRow } from './highlights';
import { dueMonth } from './highlightsAnnounce';

const H = 60 * 60 * 1000;
const D = 24 * H;

test('a month runs from the 1st at 06:00 UTC', () => {
    const b = monthBounds('2026-09');
    assert.equal(new Date(b.startMs).toISOString(), '2026-09-01T06:00:00.000Z');
    assert.equal(new Date(b.endMs).toISOString(), '2026-10-01T06:00:00.000Z');
    assert.equal(monthOf(Date.UTC(2026, 9, 1, 5, 59)), '2026-09', 'before 06:00 it is still September');
    assert.equal(monthOf(Date.UTC(2026, 9, 1, 6, 0)), '2026-10');
    assert.equal(previousMonth('2026-01'), '2025-12');
});

function row(user: string, mode: 'default' | 'team', day: number, result: number, before: number, after: number,
    ordinal: number, match = `${user}-${mode}-${day}`): HighlightRow {
    return {
        user_id: user, display_name: user[0]!.toUpperCase() + user.slice(1), avatar_url: null, mode,
        atMs: monthBounds('2026-09').startMs + day * D, result, rating_before: before, rating_after: after,
        ordinal, match_id: match,
    };
}

test('THE ONE THAT MATTERS: biggest climb needs 5 post-placement matches, and placement never counts', () => {
    const b = monthBounds('2026-09');
    const rows: HighlightRow[] = [];
    // Ana: 5 ranked 1v1 matches, +80.
    for (let i = 0; i < 5; i++) rows.push(row('ana', 'default', i + 1, 1, 1600 + i * 16, 1616 + i * 16, 20 + i));
    // Luis: 6 matches, but his first 4 are placement (ordinal ≤ 10) — only 2 count, so he is out
    // despite a huge swing.
    for (let i = 0; i < 6; i++) rows.push(row('luis', 'default', i + 1, 1, 1500 + i * 100, 1600 + i * 100, 7 + i));
    const h = computeHighlights(rows, b, b.endMs + 1);
    assert.equal(h.biggest_climb.default?.user_id, 'ana');
    assert.equal(h.biggest_climb.default?.points, 80);
    assert.equal(h.biggest_climb.default?.matches, 5);
    assert.equal(h.min_matches, 5);
    assert.equal(h.so_far, false);
});

test('most matches counts both ladders; best streak is per ladder and inside the month', () => {
    const b = monthBounds('2026-09');
    const rows: HighlightRow[] = [
        row('ana', 'default', 1, 1, 1600, 1610, 20), row('ana', 'default', 2, 1, 1610, 1620, 21),
        row('ana', 'default', 3, 1, 1620, 1630, 22),
        row('pedro', 'team', 1, 1, 1500, 1510, 9), row('pedro', 'team', 2, 0, 1510, 1500, 10),
        row('pedro', 'default', 3, 0, 1500, 1490, 30), row('pedro', 'default', 4, 0, 1490, 1480, 31),
    ];
    const h = computeHighlights(rows, b, b.startMs + 10 * D);
    assert.equal(h.most_matches?.user_id, 'pedro');
    assert.equal(h.most_matches?.matches, 4);
    assert.equal(h.best_streak.default?.user_id, 'ana');
    assert.equal(h.best_streak.default?.wins, 3);
    assert.equal(h.best_streak.team?.wins, 1);
    assert.equal(h.total_rated, 7);
    assert.equal(h.so_far, true);
});

test('rows outside the month are ignored', () => {
    const b = monthBounds('2026-09');
    const h = computeHighlights([row('ana', 'default', -3, 1, 1500, 1510, 20)], b, b.endMs);
    assert.equal(h.total_rated, 0);
    assert.equal(h.most_matches, null);
});

test('the Discord message, in the maintainer\'s words', () => {
    const b = monthBounds('2026-09');
    const rows: HighlightRow[] = [];
    for (let i = 0; i < 5; i++) rows.push(row('ana', 'default', i + 1, 1, 1600 + i * 10, 1610 + i * 10, 20 + i));
    const h = computeHighlights(rows, b, b.endMs + 1);
    assert.equal(renderDiscord(h, 'es'), [
        '🏆 Destacados de septiembre',
        '📈 Quién más subió: Ana, +50 ELO en 1v1 en 5 partidas puntuadas',
        '⚔️ Más partidas: Ana, 5 partidas puntuadas',
        '🔥 Mejor racha: Ana, 5 victorias seguidas en 1v1',
        '5 partidas puntuadas este mes. La clasificación completa está en el launcher, pestaña Clasificación.',
    ].join('\n'));
    assert.equal(renderDiscord(h, 'en'), [
        '🏆 September highlights',
        '📈 Biggest climb: Ana, +50 ELO in 1v1 over 5 rated matches',
        '⚔️ Most matches: Ana, 5 rated matches',
        '🔥 Best streak: Ana, 5 wins in a row in 1v1',
        '5 rated matches this month. The full ranking is in the launcher, Ranking tab.',
    ].join('\n'));
});

test('a month with no rated match posts nothing', () => {
    const b = monthBounds('2026-09');
    assert.equal(renderDiscord(computeHighlights([], b, b.endMs + 1), 'es'), null);
});

test('when the post is due: within the window, and only for a month that ended after the deploy', () => {
    const octFirst = Date.UTC(2026, 9, 1, 8);
    const epochBefore = Date.UTC(2026, 8, 15);
    assert.equal(dueMonth(octFirst, epochBefore, 3), '2026-09');
    assert.equal(dueMonth(octFirst + 4 * D, epochBefore, 3), null, 'past the window');
    assert.equal(dueMonth(octFirst, Date.UTC(2026, 9, 1, 7), 3), null, 'deployed after the month ended');
});
