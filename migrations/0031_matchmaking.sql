-- Quick match with a server queue (src/matchmaking).
--
-- The queue itself lives in memory: a ticket is a player waiting right now, and a restart
-- empties it (the launcher re-enters on its own). Only what has to outlive a restart is here.
--
-- lobbies.matchmaking_match_id  set on the room the server opened for two matched players.
--                               POST /lobbies/:id/join lets only those two in, the same way a
--                               tournament room admits only its entrants.
-- matchmaking_match_players     who those two are — the whitelist the join reads.
-- matchmaking_penalties         strikes for not answering or declining a match that was found.
--                               One row per player; strikes decay lazily (one every 6 h).
ALTER TABLE lobbies ADD COLUMN matchmaking_match_id TEXT;

CREATE TABLE IF NOT EXISTS matchmaking_match_players (
    match_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (match_id, user_id)
);

CREATE TABLE IF NOT EXISTS matchmaking_penalties (
    user_id        TEXT PRIMARY KEY,
    strikes        INTEGER NOT NULL DEFAULT 0,
    last_strike_at INTEGER NOT NULL DEFAULT 0,  -- epoch ms
    locked_until   INTEGER NOT NULL DEFAULT 0   -- epoch ms
);
