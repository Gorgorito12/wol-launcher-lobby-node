-- Things the operator should look at: one player beating the same opponent over and over, or a
-- pair playing a string of very short matches. Raised when a match is stored (no timer), kept
-- open until acknowledged with `admin.ts alerts:ack`. One OPEN alert per (kind, matchup).
CREATE TABLE admin_alerts (
    id               TEXT PRIMARY KEY,
    kind             TEXT NOT NULL CHECK (kind IN ('farm_streak', 'short_matches')),
    matchup_key      TEXT NOT NULL,
    user_ids         TEXT NOT NULL,            -- JSON array
    match_id         TEXT,                     -- the match that raised (or last raised) it
    value            INTEGER NOT NULL,         -- the streak, or the count of short matches
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
    acknowledged_at  TEXT
);
CREATE UNIQUE INDEX idx_admin_alerts_open ON admin_alerts (kind, matchup_key)
    WHERE acknowledged_at IS NULL;
