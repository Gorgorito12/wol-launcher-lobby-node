-- One-way hashes of the IP each member connected from, for ONE rule: a match between an account
-- younger than seven days and an opponent on the same network, ended very early, does not rate
-- (src/elo/newAccount.ts). The raw address is never stored; the hash is an HMAC under a server
-- secret (src/lib/ipHash.ts), and rows older than 30 days are pruned.
CREATE TABLE lobby_member_ips (
    lobby_id  TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    ip_hash   TEXT NOT NULL,
    seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (lobby_id, user_id, ip_hash)
);
CREATE INDEX idx_lobby_member_ips_seen ON lobby_member_ips (seen_at);

ALTER TABLE match_participants ADD COLUMN ip_hash TEXT;
