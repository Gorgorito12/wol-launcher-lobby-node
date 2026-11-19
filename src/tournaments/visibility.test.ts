/**
 * Changing a tournament's visibility, and renewing its code (src/tournaments/visibility.ts). Run:
 * `npm test`. The refusals are the point: a bracket already drawn keeps its visibility, a public
 * tournament has no code to renew, and after a renewal the OLD code opens nothing while an entrant
 * still sees the tournament.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../db';
import { insertTournament, maySee, getTournament } from './store';
import { decideVisibility, mayRenewCode } from './visibility';

test('the visibility changes only before the bracket is drawn', () => {
    for (const s of ['draft', 'registration', 'ready']) assert.equal(decideVisibility(s, 'public', 'private'), 'change', s);
    for (const s of ['running', 'finished', 'cancelled', 'abandoned']) {
        assert.equal(decideVisibility(s, 'public', 'private'), 'locked', s);
    }
    assert.equal(decideVisibility('registration', 'private', 'private'), 'unchanged');
    assert.equal(decideVisibility('registration', null, 'public'), 'unchanged');
});

test('only a private tournament has a code to renew', () => {
    assert.equal(mayRenewCode('private'), true);
    assert.equal(mayRenewCode('public'), false);
    assert.equal(mayRenewCode(null), false);
});

test('THE ONE THAT MATTERS: after a renewal the old code opens nothing, and an entrant still sees it', async () => {
    const db = new Db(':memory:');
    db.migrate('migrations');
    const raw = db.raw();
    for (const id of ['owner', 'player', 'stranger']) {
        raw.prepare(`INSERT INTO users (id, discord_id, discord_username, display_name) VALUES (?, ?, ?, ?)`)
            .run(id, `dc-${id}`, id, id);
    }
    await insertTournament(db, {
        id: 't', name: 'T', modId: 'wol', ownerUserId: 'owner', format: '1v1',
        teamSource: 'solo', entryMode: 'open', capacity: 8, visibility: 'private', inviteCode: 'OLDCODE1',
    });
    raw.prepare(`INSERT INTO tournament_entrants (id, tournament_id, kind, display_name, captain_user_id, status)
                 VALUES ('e', 't', 'solo', 'player', 'player', 'confirmed')`).run();
    raw.prepare(`INSERT INTO tournament_entrant_members (entrant_id, user_id) VALUES ('e', 'player')`).run();

    raw.prepare(`UPDATE tournaments SET invite_code = 'NEWCODE1' WHERE id = 't'`).run();
    const t = (await getTournament(db, 't'))!;
    assert.equal(await maySee(db, t, 'stranger', 'OLDCODE1'), false);
    assert.equal(await maySee(db, t, 'stranger', 'NEWCODE1'), true);
    assert.equal(await maySee(db, t, 'player', undefined), true);

    raw.prepare(`UPDATE tournaments SET visibility = 'public', invite_code = NULL WHERE id = 't'`).run();
    assert.equal(await maySee(db, (await getTournament(db, 't'))!, 'stranger', undefined), true);
});
