-- Anti-replay: one recording can score at most one match.
--
-- The launcher picks the .age3Yrec on the player's own machine, which is fine
-- against accidents (someone else's replay copied into Savegame\ was a real
-- case) and worth nothing against intent — every one of those checks runs where
-- the person who benefits can edit them. This is the server's half: the SHA-256
-- of the recording travels with the report, and the same file can never be
-- cashed in twice.
--
-- The identity is the FILE's hash, not the game's contents (map + players +
-- slots). A rematch on the same map with the same people is a different match
-- and must still score, and a content-derived identity could not tell the two
-- apart — it would reject legitimate games, which is worse than the hole it
-- closes.
--
-- Nullable, and the index is PARTIAL: most stored matches have no recording at
-- all (the game does not record by default) and those must go on coexisting.
-- Only non-null hashes are constrained.
--
-- Free side effect: this is also the idempotency key POST /matches never had.
-- A report retried after a dropped connection collides with itself instead of
-- scoring twice.
ALTER TABLE matches ADD COLUMN replay_sha256 TEXT;

CREATE UNIQUE INDEX idx_matches_replay ON matches (replay_sha256)
    WHERE replay_sha256 IS NOT NULL;

-- Who was in the room when the game actually started.
--
-- POST /matches has to reject a report that names someone who never played, but
-- it cannot ask lobby_members: leaving a room DELETES that row, and the player
-- most likely to leave first is the one who just lost. Checking live membership
-- would therefore throw out the majority of real matches while catching almost
-- nothing.
--
-- So the roster is frozen at the moment the host presses Start — which is also
-- the question worth asking, "did these people play", rather than "are these
-- people still sitting in the room". A JSON array of user ids; null for rooms
-- that started before this column existed, where the check falls back to live
-- membership.
ALTER TABLE lobbies ADD COLUMN roster_at_start TEXT;
