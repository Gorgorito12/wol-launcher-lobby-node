-- v1.0 multiplayer backend — initial schema.
--
-- Design notes:
--   * Surrogate keys are TEXT (UUID/short-id) instead of INTEGER so we can
--     mint ids in the Worker without round-tripping to D1 for a sequence.
--   * TIMESTAMP columns store ISO-8601 UTC strings ('2026-01-02T03:04:05Z')
--     so JSON serialisation is trivial and date math stays portable across
--     SQLite, the Workers runtime, and the launcher's .NET parser.
--   * Indexes target the hot paths the launcher hits on every poll:
--     (lobbies.status, lobbies.created_at), (chat_global.created_at DESC),
--     (match_history.user_id, match_history.created_at DESC).

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Users — populated on first successful Discord OAuth.
-- We store the Discord snowflake (immutable) plus the username (mutable) so
-- a rename on Discord's side doesn't orphan match history. Snowflakes are
-- 64-bit ints — stored as TEXT to avoid JS Number truncation.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id                TEXT    PRIMARY KEY,                  -- our internal id (UUID v4)
    discord_id        TEXT    NOT NULL UNIQUE,               -- Discord snowflake
    discord_username  TEXT    NOT NULL,                      -- current Discord username
    display_name      TEXT    NOT NULL,                      -- defaults to discord_username on first login
    avatar_url        TEXT,                                  -- pre-built Discord CDN URL
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    is_banned         INTEGER NOT NULL DEFAULT 0,            -- 0/1 boolean
    ban_reason        TEXT
);

CREATE INDEX idx_users_discord_id ON users (discord_id);
CREATE INDEX idx_users_last_seen ON users (last_seen_at);

-- ---------------------------------------------------------------------------
-- ELO ratings (Glicko-2). Separate table so we can extend with per-mode
-- ratings later (1v1 / team / FFA) without rewriting users.
-- One row per (user, mode); mode='default' is the only one used in v1.0.
-- ---------------------------------------------------------------------------
CREATE TABLE elo_ratings (
    user_id        TEXT    NOT NULL,
    mode           TEXT    NOT NULL DEFAULT 'default',
    rating         REAL    NOT NULL DEFAULT 1500.0,       -- Glicko-2 rating
    rd             REAL    NOT NULL DEFAULT 350.0,        -- rating deviation
    volatility     REAL    NOT NULL DEFAULT 0.06,         -- Glicko-2 vol
    games_played   INTEGER NOT NULL DEFAULT 0,
    updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, mode),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_elo_rating ON elo_ratings (mode, rating DESC);

-- ---------------------------------------------------------------------------
-- Lobbies — one row per game room. The Durable Object is the source of
-- truth for in-room state (chat history, ready state). This table is the
-- "directory" the lobby list endpoint queries — kept in D1 because the DO
-- can't be enumerated from outside itself.
-- ---------------------------------------------------------------------------
CREATE TABLE lobbies (
    id                     TEXT    PRIMARY KEY,           -- short id (8 char base32)
    host_user_id           TEXT    NOT NULL,
    title                  TEXT    NOT NULL,
    mod_id                 TEXT    NOT NULL,              -- e.g. 'wol', 'improvement-mod'
    mod_combined_hash      TEXT    NOT NULL,              -- SHA-256 from ModHashService
    max_players            INTEGER NOT NULL DEFAULT 8,
    current_players        INTEGER NOT NULL DEFAULT 1,    -- denormalised for the list
    is_private             INTEGER NOT NULL DEFAULT 0,    -- password-protected
    password_hash          TEXT,                          -- SHA-256 of password if private
    status                 TEXT    NOT NULL DEFAULT 'open' -- open|locked|in_game|closed
                                CHECK (status IN ('open','locked','in_game','closed')),
    zt_network_id          TEXT,                          -- ZeroTier network id
    zt_network_name        TEXT,                          -- ZT human label
    created_at             TEXT    NOT NULL DEFAULT (datetime('now')),
    started_at             TEXT,                          -- when 'in_game'
    closed_at              TEXT,                          -- when 'closed'
    FOREIGN KEY (host_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_lobbies_status_created ON lobbies (status, created_at DESC);
CREATE INDEX idx_lobbies_host ON lobbies (host_user_id);

-- ---------------------------------------------------------------------------
-- Lobby members. Updated on join/leave. Used for the join-availability
-- check and for the "is this user already in another lobby?" guard
-- (free tier rule: 1 active lobby per user).
-- ---------------------------------------------------------------------------
CREATE TABLE lobby_members (
    lobby_id    TEXT    NOT NULL,
    user_id     TEXT    NOT NULL,
    joined_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    is_ready    INTEGER NOT NULL DEFAULT 0,
    role        TEXT    NOT NULL DEFAULT 'player'        -- player|spectator
                        CHECK (role IN ('player','spectator')),
    PRIMARY KEY (lobby_id, user_id),
    FOREIGN KEY (lobby_id) REFERENCES lobbies(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)  REFERENCES users(id)   ON DELETE CASCADE
);

CREATE INDEX idx_lobby_members_user ON lobby_members (user_id);

-- ---------------------------------------------------------------------------
-- Persistent global chat. Per-room chat lives inside the LobbyRoom DO's
-- SQLite store (transient by design). The global chat is the only chat we
-- want to outlive a single session, so it goes here with a small retention
-- window (cleanup job trims rows older than 7 days).
-- ---------------------------------------------------------------------------
CREATE TABLE chat_global (
    id          TEXT    PRIMARY KEY,
    user_id     TEXT    NOT NULL,
    body        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_chat_global_created ON chat_global (created_at DESC);

-- ---------------------------------------------------------------------------
-- Match history. Written when the host reports a finished game. The result
-- row is the source of truth for the ELO update — Glicko-2 reads this
-- table batch-style on the periodic rating-period close.
-- ---------------------------------------------------------------------------
CREATE TABLE matches (
    id              TEXT    PRIMARY KEY,
    lobby_id        TEXT,                                  -- nullable: lobby may have been GC'd
    host_user_id    TEXT    NOT NULL,
    mod_id          TEXT    NOT NULL,
    mod_combined_hash TEXT  NOT NULL,
    map_name        TEXT,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    started_at      TEXT    NOT NULL,
    ended_at        TEXT    NOT NULL,
    replay_object_key TEXT,                                -- R2 key, null until uploaded
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_matches_started ON matches (started_at DESC);

-- One row per participant per match. score and team support 1v1, team and
-- FFA without extra tables. result is the normalised outcome the ELO
-- update consumes: 1.0 = win, 0.5 = draw, 0.0 = loss.
CREATE TABLE match_participants (
    match_id    TEXT    NOT NULL,
    user_id     TEXT    NOT NULL,
    team        INTEGER NOT NULL DEFAULT 0,
    civ         TEXT,
    score       INTEGER NOT NULL DEFAULT 0,
    result      REAL    NOT NULL DEFAULT 0.0
                        CHECK (result IN (0.0, 0.5, 1.0)),
    rating_before REAL,
    rating_after  REAL,
    PRIMARY KEY (match_id, user_id),
    FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)  REFERENCES users(id)   ON DELETE CASCADE
);

CREATE INDEX idx_match_participants_user ON match_participants (user_id, match_id);

-- ---------------------------------------------------------------------------
-- Reports — moderation surface. A user can report another for misconduct.
-- We don't auto-act on these; a maintainer reviews them via a (future)
-- admin endpoint and decides whether to set users.is_banned = 1.
-- ---------------------------------------------------------------------------
CREATE TABLE reports (
    id              TEXT    PRIMARY KEY,
    reporter_id     TEXT    NOT NULL,
    target_id       TEXT    NOT NULL,
    reason          TEXT    NOT NULL,
    context         TEXT,                                  -- lobby id, chat line, etc.
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    resolved_at     TEXT,
    resolution      TEXT,
    FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (target_id)   REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_reports_target ON reports (target_id, created_at DESC);
