/**
 * Which side of a tournament room every player is seated on. Run: `npm test`.
 *
 * <p>There is no database harness here, so what is pinned is the SQL itself, as in
 * `gameExit.test.ts`; the round trip is checked against a real schema on deploy. Two properties
 * carry the whole lock: entrant 1 is Team 1 and entrant 2 is Team 2 (the bracket's own order),
 * and the join is the same one the door uses (`isEntrantMember`), so the side a player is seated
 * on and the room that let him in can never disagree.</p>
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOURNAMENT_SIDES_SQL } from './store';

test('THE ONE THAT MATTERS: entrant 1 is Team 1 and entrant 2 is Team 2', () => {
    assert.match(TOURNAMENT_SIDES_SQL, /CASE WHEN m\.entrant_id = tm\.entrant1_id THEN 1 ELSE 2 END AS side/);
});

test('the sides come from the FROZEN rosters of exactly this bracket slot', () => {
    assert.match(TOURNAMENT_SIDES_SQL, /FROM tournament_matches tm/);
    assert.match(TOURNAMENT_SIDES_SQL,
        /JOIN tournament_entrant_members m\s+ON m\.entrant_id = tm\.entrant1_id OR m\.entrant_id = tm\.entrant2_id/);
    assert.match(TOURNAMENT_SIDES_SQL, /WHERE tm\.id = \?/);
    // Never the live team: a roster change after registration must not move anybody.
    assert.doesNotMatch(TOURNAMENT_SIDES_SQL, /team_members/);
});
