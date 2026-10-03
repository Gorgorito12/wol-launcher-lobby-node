-- One continuous ladder, rated by our own Glicko-2 engine (src/elo/glicko2.ts), with placement,
-- anti-farm and ban refunds. Seasons are gone: there is no reset, ever.
--
-- Additive, like every migration before it. `season_ratings` is NOT dropped and NOT written
-- again: it stays exactly as it was the moment this ran, the same way 0024 froze `elo_ratings`,
-- so a rollback to a build that predates this finds the table it expects (DEPLOY.md says how to
-- bring its numbers up to date). A guard test fails if any code queries either frozen table.

-- ---------------------------------------------------------------------------
-- 1. player_ratings: one row per (user, ladder). THE live ratings table.
-- ---------------------------------------------------------------------------
-- `rd` is the deviation as of `last_rated_at`. Every reader grows it to "now" with the rating-
-- period decay (src/elo/ladder.ts, effectiveRatings), so the RD a player is SHOWN is exactly the
-- RD his next match starts from. `last_rated_at` is the `matches.created_at` of the last rated
-- match on this ladder (the server's own stamp, never the clock at the moment of rating), which
-- is what makes a replay reproduce the decay to the second.
CREATE TABLE player_ratings (
    user_id        TEXT    NOT NULL,
    mode           TEXT    NOT NULL DEFAULT 'default',   -- 'default' = 1v1, 'team' = 2v2 + 3v3
    rating         REAL    NOT NULL DEFAULT 1500.0,
    rd             REAL    NOT NULL DEFAULT 500.0,
    volatility     REAL    NOT NULL DEFAULT 0.09,
    games_played   INTEGER NOT NULL DEFAULT 0,
    last_rated_at  TEXT,
    updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, mode),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_player_ratings_ladder ON player_ratings (mode, rating DESC);

-- An INTERIM copy of Season 1, so the server answers sensibly between the deploy and the
-- operator's `admin.ts elo:recompute --apply`, which rebuilds every row under the new rules.
-- Only rows with games: a missing row already means "never rated".
INSERT INTO player_ratings (user_id, mode, rating, rd, volatility, games_played, last_rated_at, updated_at)
SELECT s.user_id, s.mode, s.rating, s.rd, s.volatility, s.games_played,
       (SELECT MAX(m.created_at)
          FROM matches m JOIN match_participants p ON p.match_id = m.id
         WHERE p.user_id = s.user_id AND m.rated = 1
           AND COALESCE(m.rating_mode, 'default') = s.mode),
       s.updated_at
  FROM season_ratings s
 WHERE s.season = 1 AND s.games_played > 0;

-- ---------------------------------------------------------------------------
-- 2. What the engine decided about each rated match.
-- ---------------------------------------------------------------------------
-- Stored so the result card and the History can say WHY a win was worth less, and so the
-- anti-farm chain can be walked from stored rows alone (a replay must reproduce it exactly).
--   elo_factor       1.0 = full points; 0.2..0.9 = anti-farm. NULL = not rated by this engine.
--   farm_streak      the effective streak behind that factor (after the 24 h recovery). NULL for
--                    a tournament match, which never takes part in the chain.
--   farm_winner_key  the winning side's key (sorted user ids); NULL for a draw.
--   matchup_key      the exact matchup: mode + both sides' keys, sorted.
ALTER TABLE matches ADD COLUMN elo_factor REAL;
ALTER TABLE matches ADD COLUMN farm_streak INTEGER;
ALTER TABLE matches ADD COLUMN farm_winner_key TEXT;
ALTER TABLE matches ADD COLUMN matchup_key TEXT;

-- The bracket match this game was played for, copied from the room at report time. On the match
-- itself because the anti-farm rule must skip tournament games, and a replay reads matches.
ALTER TABLE matches ADD COLUMN tournament_match_id TEXT;
UPDATE matches
   SET tournament_match_id = (SELECT l.tournament_match_id FROM lobbies l WHERE l.id = matches.lobby_id)
 WHERE lobby_id IS NOT NULL;

CREATE INDEX idx_matches_matchup ON matches (matchup_key, created_at);

-- ---------------------------------------------------------------------------
-- 3. Ban refunds.
-- ---------------------------------------------------------------------------
-- `ban_refunds` is the operator's decision ("give back what people lost to this cheater"), placed
-- on the rating timeline at its own `created_at`. `rating_refunds` is what each player got back,
-- per ladder, RE-DERIVED by every replay from the stamps of the matches it covers, so voiding a
-- match against the banned player shrinks the refund on its own. `seen_at` survives replays: it
-- is the launcher's "Got it".
CREATE TABLE ban_refunds (
    id              TEXT PRIMARY KEY,
    banned_user_id  TEXT NOT NULL REFERENCES users(id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    since           TEXT,            -- only matches stored at or after this count; NULL = all
    reason          TEXT,
    revoked_at      TEXT             -- player:unban --revoke-refunds
);
CREATE INDEX idx_ban_refunds_banned ON ban_refunds (banned_user_id, created_at);

CREATE TABLE rating_refunds (
    refund_id      TEXT NOT NULL REFERENCES ban_refunds(id) ON DELETE CASCADE,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mode           TEXT NOT NULL,
    points         REAL NOT NULL,
    matches        INTEGER NOT NULL,
    rating_before  REAL NOT NULL,
    rating_after   REAL NOT NULL,
    seen_at        TEXT,
    PRIMARY KEY (refund_id, user_id, mode)
);
CREATE INDEX idx_rating_refunds_user ON rating_refunds (user_id, seen_at);
