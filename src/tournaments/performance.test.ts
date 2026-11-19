import test from 'node:test';
import assert from 'node:assert/strict';
import { tournamentPerformance, PERFORMANCE_CAP } from './performance';

const game = (oppRating: number, score: number, oppRd: number | null = null, oppName = 'x') =>
    ({ oppRating, oppRd, score, oppName });

test('one win and one loss against equals is their rating', () => {
    const p = tournamentPerformance([game(1600, 1), game(1600, 0)])!;
    assert.equal(p.rating, 1600);
    assert.equal(p.capped, null);
});

test('THE ONE THAT MATTERS: the champion is capped at the rivals\' mean plus 400, never infinite', () => {
    const p = tournamentPerformance([game(1500, 1), game(1700, 1), game(1600, 1)])!;
    assert.equal(p.rating, 1600 + PERFORMANCE_CAP);
    assert.equal(p.capped, 'above');
    const q = tournamentPerformance([game(1500, 0), game(1700, 0)])!;
    assert.equal(q.rating, 1600 - PERFORMANCE_CAP);
    assert.equal(q.capped, 'below');
});

test('the same score against stronger rivals is a higher figure', () => {
    const strong = tournamentPerformance([game(1800, 1), game(1700, 0)])!.rating!;
    const weak = tournamentPerformance([game(1500, 1), game(1400, 0)])!.rating!;
    assert.ok(strong > weak, `${strong} > ${weak}`);
});

test('a game where the rival was uncertain counts less', () => {
    const sure = tournamentPerformance([game(1800, 1, 50), game(1400, 0, 50)])!.rating!;
    const unsure = tournamentPerformance([game(1800, 1, 350), game(1400, 0, 50)])!.rating!;
    assert.ok(unsure < sure, `${unsure} < ${sure}`);
});

test('one counted game: no figure, but the best win', () => {
    const p = tournamentPerformance([game(1688, 1, null, 'Gorgo')])!;
    assert.equal(p.rating, null);
    assert.deepEqual(p.best_win, { name: 'Gorgo', rating: 1688 });
    assert.equal(tournamentPerformance([]), null);
});

test('the best win is the strongest rival beaten', () => {
    const p = tournamentPerformance([game(1500, 1, null, 'A'), game(1700, 1, null, 'B'), game(1900, 0, null, 'C')])!;
    assert.deepEqual(p.best_win, { name: 'B', rating: 1700 });
});
