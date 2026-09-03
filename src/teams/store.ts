/**
 * Every SQL statement the teams feature runs, in one file.
 *
 * Same shape and same reasoning as `tournaments/store.ts`: `db: Db` first rather than
 * `ctx`, and the queries live here rather than in the route so the routes and the CLI
 * cannot grow two copies of one question.
 *
 * The invariant worth stating: a team's roster is LIVE, and a tournament entrant's roster
 * is a FROZEN copy of it taken at registration. Changing a team never changes a bracket.
 */
import type { Db } from '../db';

export interface TeamRow {
    id: string;
    name: string;
    tag: string | null;
    owner_user_id: string;
    created_at: string;
    disbanded_at: string | null;
}

export interface TeamMemberRow {
    team_id: string;
    user_id: string;
    role: 'captain' | 'player';
    joined_at: string;
    display_name: string;
    discord_username: string;
    avatar_url: string | null;
}

export interface TeamInviteRow {
    id: string;
    team_id: string;
    invited_user_id: string;
    invited_by: string;
    status: 'pending' | 'accepted' | 'declined' | 'revoked';
    created_at: string;
    team_name: string;
    team_tag: string | null;
}

// ---------------------------------------------------------------- reads

export async function getTeam(db: Db, id: string): Promise<TeamRow | undefined> {
    return db.prepare(`SELECT * FROM teams WHERE id = ?`).bind(id).first<TeamRow>();
}

export async function listMembers(db: Db, teamId: string): Promise<TeamMemberRow[]> {
    const r = await db.prepare(
        `SELECT m.team_id, m.user_id, m.role, m.joined_at,
                u.display_name, u.discord_username, u.avatar_url
           FROM team_members m
           JOIN users u ON u.id = m.user_id
          WHERE m.team_id = ?
          ORDER BY m.role = 'captain' DESC, m.joined_at`,
    ).bind(teamId).all<TeamMemberRow>();
    return r.results ?? [];
}

/** Teams this user belongs to, captain or not. Disbanded ones are left out. */
export async function listTeamsOf(db: Db, userId: string): Promise<TeamRow[]> {
    const r = await db.prepare(
        `SELECT t.* FROM teams t
           JOIN team_members m ON m.team_id = t.id
          WHERE m.user_id = ? AND t.disbanded_at IS NULL
          ORDER BY t.created_at DESC`,
    ).bind(userId).all<TeamRow>();
    return r.results ?? [];
}

/**
 * Invitations still waiting for this person.
 *
 * The reason `team_invites` is a table at all: a room invite answers
 * `invite_target_offline` and forgets, which is right for something that stops existing in
 * minutes. Inviting somebody who happens to be at work is the NORMAL case for a team, so
 * the invitation has to survive being sent to nobody.
 */
export async function listInvitesFor(db: Db, userId: string): Promise<TeamInviteRow[]> {
    const r = await db.prepare(
        `SELECT i.*, t.name AS team_name, t.tag AS team_tag
           FROM team_invites i
           JOIN teams t ON t.id = i.team_id
          WHERE i.invited_user_id = ? AND i.status = 'pending' AND t.disbanded_at IS NULL
          ORDER BY i.created_at DESC`,
    ).bind(userId).all<TeamInviteRow>();
    return r.results ?? [];
}

export async function getInvite(db: Db, inviteId: string): Promise<TeamInviteRow | undefined> {
    return db.prepare(
        `SELECT i.*, t.name AS team_name, t.tag AS team_tag
           FROM team_invites i JOIN teams t ON t.id = i.team_id
          WHERE i.id = ?`,
    ).bind(inviteId).first<TeamInviteRow>();
}

export async function isMember(db: Db, teamId: string, userId: string): Promise<boolean> {
    const row = await db.prepare(
        `SELECT 1 AS ok FROM team_members WHERE team_id = ? AND user_id = ?`,
    ).bind(teamId, userId).first<{ ok: number }>();
    return !!row;
}

export async function memberCount(db: Db, teamId: string): Promise<number> {
    const row = await db.prepare(
        `SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?`,
    ).bind(teamId).first<{ n: number }>();
    return row?.n ?? 0;
}

// ---------------------------------------------------------------- writes

/** Create the team and seat its creator as captain, inseparably. */
export async function insertTeam(
    db: Db,
    t: { id: string; name: string; tag: string | null; ownerUserId: string },
): Promise<void> {
    await db.batch([
        db.prepare(
            `INSERT INTO teams (id, name, tag, owner_user_id) VALUES (?, ?, ?, ?)`,
        ).bind(t.id, t.name, t.tag, t.ownerUserId),
        db.prepare(
            `INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'captain')`,
        ).bind(t.id, t.ownerUserId),
    ]);
}

/**
 * Offer a place, or find out one is already offered.
 *
 * `INSERT OR IGNORE` against the partial unique index on open invitations, so inviting the
 * same person twice is idempotent rather than an error — a captain clicking twice has not
 * done anything wrong.
 */
export async function insertInvite(
    db: Db,
    i: { id: string; teamId: string; invitedUserId: string; invitedBy: string },
): Promise<boolean> {
    const r = await db.prepare(
        `INSERT OR IGNORE INTO team_invites (id, team_id, invited_user_id, invited_by)
         VALUES (?, ?, ?, ?)`,
    ).bind(i.id, i.teamId, i.invitedUserId, i.invitedBy).run();
    return r.changes > 0;
}

/**
 * Answer an invitation, but only one that is still open.
 *
 * The `status = 'pending'` guard is the same conditional-claim idiom used everywhere else
 * here: accepting twice would insert a second membership row, and the primary key would
 * turn that into a 500 rather than a polite refusal.
 */
export async function respondToInvite(
    db: Db,
    inviteId: string,
    next: 'accepted' | 'declined' | 'revoked',
): Promise<boolean> {
    const r = await db.prepare(
        `UPDATE team_invites SET status = ?, responded_at = datetime('now')
          WHERE id = ? AND status = 'pending'`,
    ).bind(next, inviteId).run();
    return r.changes > 0;
}

export async function addMember(db: Db, teamId: string, userId: string): Promise<void> {
    await db.prepare(
        `INSERT OR IGNORE INTO team_members (team_id, user_id, role) VALUES (?, ?, 'player')`,
    ).bind(teamId, userId).run();
}

export async function removeMember(db: Db, teamId: string, userId: string): Promise<void> {
    await db.prepare(
        `DELETE FROM team_members WHERE team_id = ? AND user_id = ?`,
    ).bind(teamId, userId).run();
}

/**
 * Disband, without deleting.
 *
 * A soft delete because tournaments that already ran point at this row and their brackets
 * still have to render a name. Cascading the rows away would blank out finished history.
 */
export async function disbandTeam(db: Db, teamId: string): Promise<void> {
    await db.prepare(
        `UPDATE teams SET disbanded_at = datetime('now') WHERE id = ? AND disbanded_at IS NULL`,
    ).bind(teamId).run();
}
