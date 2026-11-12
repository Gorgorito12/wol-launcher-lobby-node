/**
 * The tournament room's title. Run: `npm test`.
 *
 * The case that started this is the first one: a real final whose title was cut at 80 and lost
 * the last letter of the second entrant's name. The rule pinned below is that the ENTRANTS are
 * never the part that gives way.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    composeTournamentRoomTitle, shortenWithEllipsis, TOURNAMENT_ROOM_TITLE_MAX,
} from './roomTitle';

test('THE ONE THAT MATTERS: the final that read "· Gommiusta" now keeps the whole name', () => {
    const title = composeTournamentRoomTitle(
        'Wars of Liberty tournament Gommiustan', 'Final', 'UnstoppableStreletsy', 'Gommiustan');
    assert.equal(title,
        'Wars of Liberty tournament Gommiustan · Final · UnstoppableStreletsy · Gommiustan');
    assert.ok(title.length > 80, 'this title is longer than an ordinary room may be');
});

test('a short title is left exactly as composed', () => {
    assert.equal(composeTournamentRoomTitle('Copa', 'R1', 'Ana', 'Luis'), 'Copa · R1 · Ana · Luis');
});

test('when it does not fit, the TOURNAMENT name is shortened and both entrants stay whole', () => {
    const tournament = 'T'.repeat(80);
    const e1 = 'Los Conquistadores del Nuevo Mundo';
    const e2 = 'Imperio Otomano y sus Aliados de Siempre';
    const title = composeTournamentRoomTitle(tournament, 'Final', e1, e2, 100);
    assert.ok(title.length <= 100);
    assert.ok(title.endsWith(` · Final · ${e1} · ${e2}`), title);
    assert.ok(title.startsWith('T'));
    assert.ok(title.includes('…'), 'a shortened name says so');
});

test('two entrant names too long for any tournament name are shortened evenly, never one alone', () => {
    const e1 = 'A'.repeat(80);
    const e2 = 'B'.repeat(80);
    const title = composeTournamentRoomTitle('Copa del Mundo', 'R2', e1, e2);
    assert.ok(title.length <= TOURNAMENT_ROOM_TITLE_MAX, `${title.length}`);
    const kept1 = (title.match(/A/g) ?? []).length;
    const kept2 = (title.match(/B/g) ?? []).length;
    assert.ok(kept1 > 0 && kept2 > 0);
    assert.ok(Math.abs(kept1 - kept2) <= 1, `${kept1} vs ${kept2}`);
});

test('never longer than the limit, whatever the inputs', () => {
    const long = 'x'.repeat(200);
    for (const [n, r, a, b] of [
        [long, 'Final', long, long],
        [long, 'R1', 'a', 'b'],
        ['t', 'Final', long, 'b'],
        ['', '', '', ''],
    ] as const) {
        assert.ok(composeTournamentRoomTitle(n, r, a, b).length <= TOURNAMENT_ROOM_TITLE_MAX);
    }
});

test('a cut never leaves half of an emoji behind', () => {
    const name = 'Copa ⚔️' + '😀'.repeat(30);
    const short = shortenWithEllipsis(name, 20);
    assert.ok(short.length <= 20);
    const beforeEllipsis = short.charCodeAt(short.length - 2);
    assert.ok(!(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff), 'no lone high surrogate');
    assert.ok(short.endsWith('…'));
});

test('shortenWithEllipsis leaves a string that fits untouched', () => {
    assert.equal(shortenWithEllipsis('Ana', 3), 'Ana');
    assert.equal(shortenWithEllipsis('Ana', 0), '');
    assert.equal(shortenWithEllipsis('Ana', 1), '…');
});
