/**
 * Persistent teams: create one, invite people, answer an invitation, leave, disband.
 *
 * ---------------------------------------------------------------------------
 * Why a team is not a room
 * ---------------------------------------------------------------------------
 * Nothing in this database modelled a GROUP before. `match_participants.team` is a side in
 * one game, `lobbies.roster_at_start` is a snapshot of who was in one room, and
 * `lobby_members.role` is player-or-spectator. All three die with the match. A team is the
 * opposite: two people make one on Monday and enter a tournament with it on Friday.
 *
 * ---------------------------------------------------------------------------
 * The one thing the room invite could not do
 * ---------------------------------------------------------------------------
 * `GlobalChatRoom.handleInvite` looks up the target's live socket and answers
 * `invite_target_offline` if there is none. Correct for a room, which is gone in minutes.
 * Wrong for a team, where inviting somebody who is at work is the normal case — so the
 * invitation is a ROW, delivered by push when they happen to be connected and waiting in
 * the tab when they are not.
 *
 * ---------------------------------------------------------------------------
 * Permission
 * ---------------------------------------------------------------------------
 * Ownership again, and inline rather than as a preHandler: unlike a tournament, several of
 * these routes are legal for a member as well as the captain (leaving is the obvious one),
 * so the check differs per route and a shared guard would have to be argued with.
 */
import type { FastifyInstance } from 'fastify';
import { Errors } from '../lib/errors';
import { uuid, shortId } from '../lib/ids';
import { requireAuth } from '../middleware/auth';
import { userRateLimit, Limits } from '../middleware/rateLimit';
import type { AppContext } from '../context';
import * as store from './store';

const NAME_MAX = 40;
const NAME_MIN = 2;
const TAG_MAX = 8;

/**
 * Members one team may hold.
 *
 * Six rather than three: a 3v3 squad wants substitutes, and the roster that actually plays
 * is chosen at registration and frozen there. Capping at exactly the format size would
 * mean a team could never carry a reserve.
 */
const TEAM_MAX_MEMBERS = 6;

/** Teams one person may own. Cheap rows, but an unbounded list is still a list. */
const MAX_OWNED_TEAMS = 5;

function paramOf(req: { params: unknown }, key: string): string {
    return (req.params as Record<string, string | undefined>)[key] ?? '';
}

export function registerTeamsRest(app: FastifyInstance, ctx: AppContext): void {
    // ------------------------------------------------------------ reads

    app.get('/teams/mine', {
        preHandler: [requireAuth()],
    }, async (req) => {
        const userId = req.userId!;
        const teams = await store.listTeamsOf(ctx.db, userId);
        const withMembers = await Promise.all(teams.map(async (t) => ({
            ...teamView(t),
            members: (await store.listMembers(ctx.db, t.id)).map(memberView),
        })));
        const invites = (await store.listInvitesFor(ctx.db, userId)).map(inviteView);
        return { teams: withMembers, invites };
    });

    app.get('/teams/:id', async (req) => {
        const id = paramOf(req, 'id');
        const t = await store.getTeam(ctx.db, id);
        if (!t) throw Errors.NotFound('Team');
        return { ...teamView(t), members: (await store.listMembers(ctx.db, id)).map(memberView) };
    });

    // ------------------------------------------------------------ writes

    app.post('/teams', {
        preHandler: [requireAuth(), userRateLimit(ctx, Limits.TeamInviteUser)],
    }, async (req) => {
        const userId = req.userId!;
        const body = (req.body ?? {}) as { name?: unknown; tag?: unknown };

        const name = typeof body.name === 'string' ? body.name.trim().slice(0, NAME_MAX) : '';
        if (name.length < NAME_MIN) throw Errors.BadRequest('name too short');
        const tag = typeof body.tag === 'string' && body.tag.trim()
            ? body.tag.trim().slice(0, TAG_MAX)
            : null;

        const owned = (await store.listTeamsOf(ctx.db, userId))
            .filter((t) => t.owner_user_id === userId).length;
        if (owned >= MAX_OWNED_TEAMS) {
            throw Errors.Conflict('You already have as many teams as you may own.');
        }

        const id = shortId(8);
        await store.insertTeam(ctx.db, { id, name, tag, ownerUserId: userId });
        return { id, name, tag };
    });

    app.post('/teams/:id/invites', {
        preHandler: [requireAuth(), userRateLimit(ctx, Limits.TeamInviteUser)],
    }, async (req) => {
        const userId = req.userId!;
        const teamId = paramOf(req, 'id');

        const t = await store.getTeam(ctx.db, teamId);
        if (!t || t.disbanded_at) throw Errors.NotFound('Team');
        if (t.owner_user_id !== userId) throw Errors.NotTeamCaptain();

        const body = (req.body ?? {}) as { user_id?: unknown };
        const target = typeof body.user_id === 'string' ? body.user_id : '';
        if (!target) throw Errors.BadRequest('user_id required');
        if (target === userId) throw Errors.BadRequest('you are already in this team');
        if (await store.isMember(ctx.db, teamId, target)) {
            throw Errors.Conflict('That player is already in this team.');
        }
        if (await store.memberCount(ctx.db, teamId) >= TEAM_MAX_MEMBERS) {
            throw Errors.TeamFull();
        }

        // Refuse an invitation to somebody who does not exist rather than storing a row
        // pointing at nobody — the foreign key would turn that into a nameless 500.
        const exists = await ctx.db.prepare(
            `SELECT 1 AS ok FROM users WHERE id = ?`,
        ).bind(target).first<{ ok: number }>();
        if (!exists) throw Errors.NotFound('Player');

        const id = uuid();
        const fresh = await store.insertInvite(ctx.db, {
            id, teamId, invitedUserId: target, invitedBy: userId,
        });

        // Push it if they are online; the row is what makes it survive if they are not.
        if (fresh) {
            ctx.globalChat.announceTeamInvite({
                inviteId: id, teamId, teamName: t.name, fromUserId: userId, toUserId: target,
            });
        }
        return { ok: true, invite_id: id, already_pending: !fresh };
    });

    app.post('/teams/invites/:id/accept', {
        preHandler: [requireAuth(), userRateLimit(ctx, Limits.TeamInviteUser)],
    }, async (req) => {
        const userId = req.userId!;
        const inviteId = paramOf(req, 'id');

        const inv = await store.getInvite(ctx.db, inviteId);
        if (!inv) throw Errors.NotFound('Invitation');
        if (inv.invited_user_id !== userId) throw Errors.Forbidden();

        // Re-check the cap at ACCEPT time, not only at invite time: a captain can send more
        // invitations than there are places, and whoever answers last would otherwise walk
        // into a team that is over its size.
        if (await store.memberCount(ctx.db, inv.team_id) >= TEAM_MAX_MEMBERS) {
            throw Errors.TeamFull();
        }

        const claimed = await store.respondToInvite(ctx.db, inviteId, 'accepted');
        if (!claimed) throw Errors.Conflict('That invitation has already been answered.');

        await store.addMember(ctx.db, inv.team_id, userId);
        return { ok: true, team_id: inv.team_id };
    });

    app.post('/teams/invites/:id/decline', {
        preHandler: [requireAuth(), userRateLimit(ctx, Limits.TeamInviteUser)],
    }, async (req) => {
        const userId = req.userId!;
        const inviteId = paramOf(req, 'id');
        const inv = await store.getInvite(ctx.db, inviteId);
        if (!inv) throw Errors.NotFound('Invitation');
        // Either side may end it: the invitee declines, the captain withdraws the offer.
        if (inv.invited_user_id !== userId && inv.invited_by !== userId) throw Errors.Forbidden();

        const next = inv.invited_user_id === userId ? 'declined' : 'revoked';
        const claimed = await store.respondToInvite(ctx.db, inviteId, next);
        if (!claimed) throw Errors.Conflict('That invitation has already been answered.');
        return { ok: true };
    });

    app.post('/teams/:id/members/:userId/remove', {
        preHandler: [requireAuth(), userRateLimit(ctx, Limits.TeamInviteUser)],
    }, async (req) => {
        const me = req.userId!;
        const teamId = paramOf(req, 'id');
        const target = paramOf(req, 'userId');

        const t = await store.getTeam(ctx.db, teamId);
        if (!t || t.disbanded_at) throw Errors.NotFound('Team');
        // The captain removes anybody; anybody removes themselves.
        if (t.owner_user_id !== me && target !== me) throw Errors.Forbidden();

        // The captain cannot walk out of their own team. Handing a team to whoever joined
        // first — the way a ROOM migrates — would be wrong here: a team is something
        // somebody made, and inheriting one you did not ask for is not a favour.
        if (target === t.owner_user_id) {
            throw Errors.Conflict('The captain cannot leave; disband the team instead.');
        }

        await store.removeMember(ctx.db, teamId, target);
        return { ok: true };
    });

    app.post('/teams/:id/disband', {
        preHandler: [requireAuth(), userRateLimit(ctx, Limits.TeamInviteUser)],
    }, async (req) => {
        const userId = req.userId!;
        const teamId = paramOf(req, 'id');
        const t = await store.getTeam(ctx.db, teamId);
        if (!t) throw Errors.NotFound('Team');
        if (t.owner_user_id !== userId) throw Errors.NotTeamCaptain();

        // Soft: tournaments that already ran point here and their brackets still have to
        // render a name. Entrants keep their frozen rosters and are unaffected.
        await store.disbandTeam(ctx.db, teamId);
        return { ok: true };
    });
}

function teamView(t: store.TeamRow): Record<string, unknown> {
    return {
        id: t.id, name: t.name, tag: t.tag,
        owner_user_id: t.owner_user_id, created_at: t.created_at,
        disbanded: t.disbanded_at !== null,
    };
}

function memberView(m: store.TeamMemberRow): Record<string, unknown> {
    return {
        user_id: m.user_id, role: m.role, joined_at: m.joined_at,
        display_name: m.display_name, discord_username: m.discord_username,
        avatar_url: m.avatar_url,
    };
}

function inviteView(i: store.TeamInviteRow): Record<string, unknown> {
    return {
        id: i.id, team_id: i.team_id, team_name: i.team_name, team_tag: i.team_tag,
        invited_by: i.invited_by, created_at: i.created_at,
    };
}
