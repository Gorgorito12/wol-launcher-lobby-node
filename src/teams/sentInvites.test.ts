/**
 * The invitations a captain has sent. Run: `npm test`.
 *
 * No database harness here, so what is pinned is the SQL the decision is written in, as in
 * `listing.test.ts`. An answered invitation listed as pending is a promise the screen cannot keep,
 * and one from a disbanded team is an offer to join nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SENT_INVITES_SQL } from './store';

test('only what this person sent and nobody answered', () => {
    assert.match(SENT_INVITES_SQL, /i\.invited_by = \?/);
    assert.match(SENT_INVITES_SQL, /i\.status = 'pending'/);
    assert.match(SENT_INVITES_SQL, /t\.disbanded_at IS NULL/);
});

test('it carries the name, because a row of ids draws nothing', () => {
    assert.match(SENT_INVITES_SQL, /AS invited_name/);
});

test('the route answers it beside what was received', () => {
    const rest = readFileSync('src/teams/rest.ts', 'utf8');
    assert.match(rest, /return \{ teams: withMembers, invites, sent_invites: sentInvites \}/);
});
