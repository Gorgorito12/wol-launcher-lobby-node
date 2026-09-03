-- Persistent teams: a group of players that survives a single match.
--
-- Nothing in this database has ever modelled a GROUP. `match_participants.team` is a
-- side in one game, `lobbies.roster_at_start` is a snapshot of who was in one room, and
-- `lobby_members.role` is player-or-spectator. All three are per-match facts that die
-- with the match. A team tournament needs the opposite: something two people can create
-- on Monday and enter a tournament with on Friday.
--
-- Shipped ahead of the tournament tables (0014) rather than with them because
-- `tournament_entrants.team_id` points here, and migrations run in lexicographic order.
-- The ROUTES that use these tables land later; the schema has to be in first.

CREATE TABLE teams (
    id            TEXT PRIMARY KEY,              -- shortId(8), same shape as a lobby id
    name          TEXT NOT NULL,
    -- Optional short tag, e.g. "WoL". Purely cosmetic; nothing keys off it and it is
    -- NOT unique — two teams may pick the same tag and that is not a conflict worth
    -- refusing a registration over.
    tag           TEXT,
    -- The captain. Unlike lobbies.host_user_id this is NOT migrated when the owner
    -- leaves: a team with no captain is disbanded instead, because a team is a thing
    -- somebody made rather than a room people wandered into.
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    -- Soft delete. A disbanded team must stay readable, because tournaments that already
    -- ran reference it and their brackets have to keep rendering a name.
    disbanded_at  TEXT
);
CREATE INDEX idx_teams_owner ON teams (owner_user_id);

CREATE TABLE team_members (
    team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('captain','player')),
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (team_id, user_id)
);
-- "Which teams am I in?" is the first query the launcher makes on this table.
CREATE INDEX idx_team_members_user ON team_members (user_id);

-- A team invitation, and the reason this is a TABLE rather than a socket frame.
--
-- The room invite (GlobalChatRoom.handleInvite) looks up the target's live socket and
-- answers `invite_target_offline` if there isn't one. That is right for a room, which
-- stops existing in minutes. It is wrong for a team: inviting somebody who happens to be
-- offline is the normal case, and an invitation that evaporates because the recipient was
-- at work is not an invitation. So it persists, is delivered by push when they ARE
-- connected, and is waiting in the tab when they next open it.
CREATE TABLE team_invites (
    id              TEXT PRIMARY KEY,            -- uuid
    team_id         TEXT NOT NULL REFERENCES teams(id)  ON DELETE CASCADE,
    invited_user_id TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    invited_by      TEXT NOT NULL REFERENCES users(id),
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','accepted','declined','revoked')),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    responded_at    TEXT
);
-- One OPEN invitation per (team, user) at a time — a partial unique index rather than a
-- plain one, so a declined invitation does not block re-inviting the same person later.
CREATE UNIQUE INDEX idx_team_invite_open ON team_invites (team_id, invited_user_id)
    WHERE status = 'pending';
CREATE INDEX idx_team_invite_user ON team_invites (invited_user_id, status);
