-- Achievements (2026-11-21, design 121 "Logros" in the launcher repo).
--
-- One row per medal a player has earned IN ONE GAME (mod). Medals are counted per game: fifty
-- wins in Wars of Liberty earn nothing in The Asian Dynasties. The catalogue, the rules and the
-- evaluation live in src/achievements/; this table only remembers what was given and when.
--
-- tier: 0 for an ordinary medal; 1-5 for the ages of "Promotion" (colonial … sovereign), which is
-- one achievement with five medals.
--
-- A medal, once earned, is never taken back by the code: a voided or replayed match does not
-- remove it. The evaluator only ever INSERT OR IGNOREs. An operator can revoke one with the admin
-- CLI, which sets revoked_at instead of deleting the row — deleting it would let the next
-- evaluation hand it straight back.
--
-- match_id / tournament_id: what crossed the line, for the record. Deliberately NOT foreign keys:
-- the founding rollback deletes match rows (src/matches/rest.ts) and a medal referencing one would
-- make that DELETE throw with foreign keys on.
--
-- seen_at: when the player's launcher showed it. NULL = the launcher still owes him the
-- celebration. Medals for matches older than this migration are written already seen, so the
-- first launch after the deploy does not throw fifteen cards at somebody.
CREATE TABLE IF NOT EXISTS player_achievements (
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mod_key        TEXT NOT NULL,
    achievement_id TEXT NOT NULL,
    tier           INTEGER NOT NULL DEFAULT 0,
    earned_at      TEXT NOT NULL,
    match_id       TEXT,
    tournament_id  TEXT,
    seen_at        TEXT,
    revoked_at     TEXT,
    PRIMARY KEY (user_id, mod_key, achievement_id, tier)
);

-- The "played in a room" join the evaluator makes for every match of a player, and the rooms a
-- player created ("Host"). matches.lobby_id had no index at all.
CREATE INDEX IF NOT EXISTS idx_matches_lobby ON matches (lobby_id) WHERE lobby_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lobbies_created_by ON lobbies (created_by) WHERE created_by IS NOT NULL;
