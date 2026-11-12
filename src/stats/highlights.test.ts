/** Monthly highlights and the Discord message. Run: `npm test`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHighlights, forCommunity, HIGHLIGHT_LEADERS, monthBounds, monthOf, previousMonth, renderDiscord, type HighlightRow } from './highlights';
import { dueMonth, highlightsEmbeds, highlightsMessage } from './highlightsAnnounce';
import { embedName, HIGHLIGHTS_EMBED_COLOR, renderDiscordEmbed } from './highlights';

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

// ---------------------------------------------------------------- most wins, win rate, civ, upset

function crow(user: string, day: number, result: number, opts: {
    mode?: 'default' | 'team'; before?: number; ordinal?: number; match?: string; civ?: string | null; mod?: string;
} = {}): HighlightRow {
    const r = row(user, opts.mode ?? 'default', day, result, opts.before ?? 1500, (opts.before ?? 1500) + (result ? 10 : -10),
        opts.ordinal ?? 30, opts.match ?? `${user}-${day}-${result}`);
    return { ...r, civ: opts.civ ?? null, mod_id: opts.mod ?? 'wol' };
}

test('most wins adds up both ladders, and a tie goes to whoever played fewer', () => {
    const b = monthBounds('2026-09');
    const rows: HighlightRow[] = [
        // Ana: 3 wins out of 5, two of them in teams.
        crow('ana', 1, 1), crow('ana', 2, 1, { mode: 'team' }), crow('ana', 3, 1, { mode: 'team' }),
        crow('ana', 4, 0), crow('ana', 5, 0),
        // Beto: 3 wins out of 3 — the same wins, fewer games: his month.
        crow('beto', 1, 1), crow('beto', 2, 1), crow('beto', 3, 1),
        // Ciro: played the most, won once.
        ...[1, 2, 3, 4, 5, 6].map((d) => crow('ciro', d, d === 1 ? 1 : 0)),
    ];
    const h = computeHighlights(rows, b, b.endMs + 1);
    assert.equal(h.most_wins?.user_id, 'beto');
    assert.equal(h.most_wins?.wins, 3);
    assert.equal(h.most_wins?.matches, 3);
    assert.equal(h.most_matches?.user_id, 'ciro', 'most matches is still its own highlight');
});

test('nobody with a win, no most-wins highlight', () => {
    const b = monthBounds('2026-09');
    const h = computeHighlights([crow('ana', 1, 0), crow('beto', 2, 0)], b, b.endMs + 1);
    assert.equal(h.most_wins, null);
});

test('THE ONE THAT MATTERS: best win rate needs 10 matches — a 9-0 does not enter, a 10-1 does', () => {
    const b = monthBounds('2026-09');
    const rows: HighlightRow[] = [];
    for (let d = 1; d <= 9; d++) rows.push(crow('perfecto', d, 1));
    for (let d = 1; d <= 11; d++) rows.push(crow('ana', d, d === 11 ? 0 : 1));
    for (let d = 1; d <= 12; d++) rows.push(crow('beto', d, d <= 6 ? 1 : 0));
    const h = computeHighlights(rows, b, b.endMs + 1);
    assert.equal(h.best_win_rate?.user_id, 'ana');
    assert.equal(h.best_win_rate?.wins, 10);
    assert.equal(h.best_win_rate?.matches, 11);
    assert.equal(h.best_win_rate?.percent, 91);
});

test('with nobody at 10 matches there is no best win rate', () => {
    const b = monthBounds('2026-09');
    const rows: HighlightRow[] = [];
    for (let d = 1; d <= 9; d++) rows.push(crow('ana', d, 1));
    assert.equal(computeHighlights(rows, b, b.endMs + 1).best_win_rate, null);
});

test('civilization of the month: blank civs ignored, 3 picks needed, two mods kept apart', () => {
    const b = monthBounds('2026-09');
    const rows: HighlightRow[] = [
        // "Germans" twice in WoL and twice in another mod: two different civilizations, 2 picks each.
        crow('a', 1, 1, { civ: 'Germans' }), crow('b', 1, 0, { civ: 'Germans' }),
        crow('c', 2, 1, { civ: 'Germans', mod: 'improvement-mod' }), crow('d', 2, 0, { civ: 'Germans', mod: 'improvement-mod' }),
        // Blank and null are not a civilization, however many there are.
        crow('e', 3, 1, { civ: ' ' }), crow('f', 3, 0, { civ: ' ' }), crow('g', 4, 1, { civ: null }),
        crow('h', 4, 0, { civ: null }), crow('i', 5, 1, { civ: null }),
    ];
    assert.equal(computeHighlights(rows, b, b.endMs + 1).top_civ, null, 'nothing reaches 3 picks');

    rows.push(crow('j', 6, 1, { civ: 'Germans' }));
    const h = computeHighlights(rows, b, b.endMs + 1);
    assert.deepEqual(h.top_civ, { mod_id: 'wol', civ: 'Germans', picks: 3, wins: 2 });
});

test('THE ONE THAT MATTERS: the biggest upset uses side averages and only placed players', () => {
    const b = monthBounds('2026-09');
    const rows: HighlightRow[] = [
        // A 1v1 the favourite won: not an upset.
        crow('fav', 1, 1, { before: 1800, match: 'm1' }), crow('weak', 1, 0, { before: 1500, match: 'm1' }),
        // A 2v2: Ana (1500) + Luis (1540) beat Pedro (1700) + Sara (1660). Gap = 1680 - 1520 = 160.
        crow('ana', 2, 1, { mode: 'team', before: 1500, match: 'm2' }), crow('luis', 2, 1, { mode: 'team', before: 1540, match: 'm2' }),
        crow('pedro', 2, 0, { mode: 'team', before: 1700, match: 'm2' }), crow('sara', 2, 0, { mode: 'team', before: 1660, match: 'm2' }),
        // A bigger gap, but the winner is still in placement (ordinal 4 of 10): it does not count.
        crow('nuevo', 3, 1, { before: 1500, ordinal: 4, match: 'm3' }), crow('alto', 3, 0, { before: 2000, match: 'm3' }),
    ];
    const h = computeHighlights(rows, b, b.endMs + 1);
    assert.equal(h.biggest_upset?.match_id, 'm2');
    assert.equal(h.biggest_upset?.mode, 'team');
    assert.equal(h.biggest_upset?.gap, 160);
    assert.deepEqual(h.biggest_upset?.winners.map((p) => p.user_id), ['ana', 'luis']);
    assert.deepEqual(h.biggest_upset?.losers.map((p) => p.user_id), ['pedro', 'sara']);
    assert.equal(h.biggest_upset?.winners_rating, 1520);
    assert.equal(h.biggest_upset?.losers_rating, 1680);
});

test('the favourite winning every match is no upset at all', () => {
    const b = monthBounds('2026-09');
    const rows: HighlightRow[] = [
        crow('fav', 1, 1, { before: 1800, match: 'm1' }), crow('weak', 1, 0, { before: 1500, match: 'm1' }),
        crow('even', 2, 1, { before: 1600, match: 'm2' }), crow('even2', 2, 0, { before: 1600, match: 'm2' }),
    ];
    assert.equal(computeHighlights(rows, b, b.endMs + 1).biggest_upset, null);
});

// ---------------------------------------------------------------- the top lists (leaders)

test('THE ONE THAT MATTERS: every singular field is the first of its top list', () => {
    const b = monthBounds('2026-09');
    const rows: HighlightRow[] = [];
    // Seven players with different records, enough of everything to fill every list.
    const names = ['ana', 'beto', 'ciro', 'dora', 'eva', 'fito', 'gus'];
    names.forEach((n, i) => {
        for (let d = 1; d <= 12; d++) {
            rows.push(crow(n, d, d <= 12 - i ? 1 : 0, {
                before: 1500 + i * 30, ordinal: 30 + d, match: `${n}-${d}`, civ: i % 2 ? 'Germans' : 'Dutch',
            }));
        }
    });
    const h = computeHighlights(rows, b, b.endMs + 1);
    assert.deepEqual(h.most_wins, h.leaders.most_wins[0]);
    assert.deepEqual(h.most_matches, h.leaders.most_matches[0]);
    assert.deepEqual(h.best_win_rate, h.leaders.best_win_rate[0]);
    assert.deepEqual(h.top_civ, h.leaders.top_civ[0]);
    assert.deepEqual(h.biggest_upset ?? null, h.leaders.biggest_upset[0] ?? null);
    assert.deepEqual(h.biggest_climb.default ?? null, h.leaders.biggest_climb.default[0] ?? null);
    assert.deepEqual(h.best_streak.default ?? null, h.leaders.best_streak.default[0] ?? null);
    // At most five, in order.
    assert.equal(h.leaders.most_wins.length, HIGHLIGHT_LEADERS);
    assert.deepEqual(h.leaders.most_wins.map((p) => p.user_id), ['ana', 'beto', 'ciro', 'dora', 'eva']);
    assert.deepEqual(h.leaders.most_wins.map((p) => p.wins), [12, 11, 10, 9, 8]);
    // Most matches carries the wins too, for the detail line.
    assert.ok(h.leaders.most_matches.every((p) => typeof p.wins === 'number'));
});

test('the top lists keep their thresholds: a 9-0, a placement upset and a 2-pick civ stay out', () => {
    const b = monthBounds('2026-09');
    const rows: HighlightRow[] = [];
    for (let d = 1; d <= 9; d++) rows.push(crow('perfecto', d, 1, { civ: 'Rara' }));
    rows.push(crow('dos', 1, 1, { civ: 'Dos' }), crow('dos', 2, 0, { civ: 'Dos' }));
    for (let d = 1; d <= 10; d++) rows.push(crow('ana', d, d <= 5 ? 1 : 0, { civ: 'Germans' }));
    // A newcomer (ordinal 4) beating someone 500 above him: not an upset.
    rows.push(crow('nuevo', 20, 1, { before: 1500, ordinal: 4, match: 'm-new' }));
    rows.push(crow('alto', 20, 0, { before: 2000, match: 'm-new' }));
    const h = computeHighlights(rows, b, b.endMs + 1);
    assert.deepEqual(h.leaders.best_win_rate.map((p) => p.user_id), ['ana'], 'the 9-0 never enters');
    assert.ok(h.leaders.biggest_upset.every((u) => u.match_id !== 'm-new'));
    assert.deepEqual(h.leaders.top_civ.map((c) => c.civ), ['Germans', 'Rara'], 'Dos, with 2 picks, never enters');
});

test('the community payload carries no top lists', () => {
    const b = monthBounds('2026-09');
    const h = computeHighlights([crow('ana', 1, 1)], b, b.endMs + 1);
    const pair = forCommunity({ current: h, previous: h })!;
    assert.equal('leaders' in pair.current, false);
    assert.equal('leaders' in pair.previous, false);
    assert.equal(pair.current.most_wins?.user_id, 'ana', 'the singular fields stay');
    assert.equal(forCommunity(null), null);
});

// ---------------------------------------------------------------- the Discord card (2026-11-11)

/** A full month: Ana climbs (with a picture), Bea has the longest run, a civ and an upset exist. */
function fullMonth() {
    const b = monthBounds('2026-10');
    const at = (day: number) => monthBounds('2026-10').startMs + day * D;
    const rows: HighlightRow[] = [];
    for (let i = 0; i < 12; i++) {
        rows.push({ ...crow('ana', i + 1, 1, { before: 1600 + i * 15, civ: 'British', match: `a${i}` }),
            atMs: at(i + 1), avatar_url: 'https://cdn.example/ana.png' });
        rows.push({ ...crow('bea', i + 1, 0, { before: 1700, civ: 'British', match: `a${i}` }), atMs: at(i + 1) });
    }
    return computeHighlights(rows, b, b.endMs + 1);
}

test('THE ONE THAT MATTERS: the card, in English, with every category and no mention', () => {
    const h = fullMonth();
    const card = renderDiscordEmbed(h, 'en')!;
    assert.equal(card.title, '🏆 October highlights');
    assert.equal(card.description, '12 rated matches this month');
    assert.equal(card.color, HIGHLIGHTS_EMBED_COLOR);
    assert.equal(card.thumbnail?.url, 'https://cdn.example/ana.png');
    const names = card.fields.map((f) => f.name);
    assert.deepEqual(names.slice(0, 3), ['📈 Biggest climb', '⚔️ Most matches', '🔥 Best streak']);
    assert.ok(card.fields.slice(0, 3).every((f) => f.inline));
    assert.ok(card.fields[0]!.value.startsWith('🥇 Ana +'));
    assert.ok(names.includes('🏰 Civilization of the month'));
    const upset = card.fields.find((f) => f.name === '⚡ Biggest upset')!;
    assert.equal(upset.inline, false);
    assert.match(upset.value, /^Ana beat Bea from \d+ ELO below · 1v1$/);
    assert.equal(card.footer.text, 'AoE3 Mod Launcher · Ranking tab');

    const body = highlightsMessage(highlightsEmbeds(h, 'en'));
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    assert.equal(body.embeds.length, 1);
    assert.equal('content' in body, false, 'the card, not the old plain text');
});

test('a podium shows the players there are, and an empty category is left out', () => {
    const b = monthBounds('2026-09');
    const rows: HighlightRow[] = [];
    for (let i = 0; i < 5; i++) rows.push(row('ana', 'default', i + 1, 1, 1600 + i * 10, 1610 + i * 10, 20 + i));
    const card = renderDiscordEmbed(computeHighlights(rows, b, b.endMs + 1), 'en')!;
    const climb = card.fields.find((f) => f.name === '📈 Biggest climb')!;
    // A 1v1 entry carries no ladder tag, and the number never leaves the name (no-break space).
    assert.equal(climb.value, '🥇 Ana\u00a0+50');
    assert.equal(card.fields.some((f) => f.name === '⚡ Biggest upset'), false);
    assert.equal(card.fields.some((f) => f.name === '🎯 Best win rate'), false, '5 matches is under the 10 the rate needs');
    assert.equal(card.thumbnail, undefined, 'no picture, no thumbnail');
});

test('an empty month posts no card; both languages are two cards, Spanish first', () => {
    const b = monthBounds('2026-09');
    const empty = computeHighlights([], b, b.endMs + 1);
    assert.equal(renderDiscordEmbed(empty, 'en'), null);
    assert.deepEqual(highlightsEmbeds(empty, 'both'), []);
    const both = highlightsEmbeds(fullMonth(), 'both');
    assert.equal(both.length, 2);
    assert.equal(both[0]!.title, '🏆 Destacados de octubre');
    assert.equal(both[1]!.title, '🏆 October highlights');
});

test('a name cannot format the card or break its limits', () => {
    // String.raw: what Discord receives is a backslash before each mark.
    assert.equal(embedName('_cool_*guy*'), String.raw`\_cool\_\*guy\*`);
    assert.equal(embedName(String.raw`a\b`), String.raw`a\\b`);
    const long = embedName('x'.repeat(80));
    assert.equal(long.length, 32);
    assert.ok(long.endsWith('…'));
    for (const f of renderDiscordEmbed(fullMonth(), 'es')!.fields) assert.ok(f.value.length <= 1024);
});
