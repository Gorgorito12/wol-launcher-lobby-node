-- The other player's own reading of the same match.
--
-- Only the HOST reports a result, and their opponent's score is arithmetic rather
-- than measurement: MatchResultResolver.ParticipantResult computes 1.0 minus the
-- host's. That is correct for a 1v1 — there is exactly one winner — but it means
-- the server gets ONE reading of something two machines can read.
--
-- Both of them already do. OnGameExitedAsync runs on every client, and on the
-- guest's machine the replay search identifies THEIR recording by THEIR profile
-- name and slot, then compares that slot against the trailer's absolute
-- WinnerSlot/LoserSlot. The guest reaches an independent verdict about the same
-- fact and, until now, threw it away.
--
-- This table keeps it. It GATED NOTHING when it was written: matches rated exactly as they
-- did before, and this table only recorded how the two readings compared.
--
-- THAT IS NO LONGER TRUE, and the comment is left standing rather than rewritten so the
-- change is visible. Since migration 0006 a reading stored here can DECIDE a match the
-- server stored without a result — see canUpgradeFromConfirmation in src/elo/ratability.ts.
-- It still cannot overturn a match that already scored, and reporting is still host-only.
-- It exists so that in a few weeks there is real data on how often the two
-- readings disagree, and — the number that actually decides whether agreement can
-- ever be required — how often the second reading simply never arrives.
--
-- Keyed by (lobby_id, user_id) and NOT by match_id, which is the whole design.
-- The guest usually leaves the game BEFORE the host (they are the one who just
-- lost), so their confirmation can arrive while the match row does not exist yet.
-- The lobby always does: those rows are never deleted. match_id is filled in
-- afterwards, by whichever side arrives second. The primary key also makes a
-- resend overwrite instead of piling up duplicates.
CREATE TABLE match_confirmations (
    lobby_id      TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    result        REAL NOT NULL DEFAULT 0.5
                        CHECK (result IN (0.0, 0.5, 1.0)),
    replay_sha256 TEXT,
    match_id      TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (lobby_id, user_id)
);

-- For the "did these two agree" query once a match has been tied to its
-- confirmations, and for the deploy-time report in DEPLOY.md.
CREATE INDEX idx_match_confirmations_match ON match_confirmations (match_id);
