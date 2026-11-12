-- Rating seasons: the ladder restarts every three months and every season's final table is
-- kept for good (launcher "temporadas"; the calendar is src/elo/seasons.ts).
--
-- Additive, like every migration before it. `elo_ratings` is NOT dropped and NOT written again:
-- it stays exactly as it was the moment this ran, so a rollback to a build that predates
-- seasons finds the table it expects (and DEPLOY.md says how to bring its numbers up to date).
--
-- ---------------------------------------------------------------------------
-- 1. season_ratings — one row per (user, ladder, season).
-- ---------------------------------------------------------------------------
-- A season that has just begun has NO rows: that absence is the reset, at the boundary instant,
-- for every reader at once — nothing has to run for it to happen. A player's first rated match
-- of a season starts from the soft reset of the last season he played (src/elo/glicko2.ts,
-- effectiveRatings), and only then does he get a row.
CREATE TABLE season_ratings (
    user_id        TEXT    NOT NULL,
    mode           TEXT    NOT NULL DEFAULT 'default',   -- 'default' = 1v1, 'team' = 2v2 + 3v3
    season         INTEGER NOT NULL,
    rating         REAL    NOT NULL DEFAULT 1500.0,
    rd             REAL    NOT NULL DEFAULT 350.0,
    volatility     REAL    NOT NULL DEFAULT 0.06,
    -- RATED matches of this ladder in this season. The ladder's entry bar (MIN_DECIDED) reads
    -- it, so a new season's table fills as people play rather than inheriting last season's.
    games_played   INTEGER NOT NULL DEFAULT 0,
    updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, mode, season),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Every ladder query asks for one season of one mode.
CREATE INDEX idx_season_ratings_ladder ON season_ratings (season, mode);

-- Season 1 is the ladder as it stands today, copied unchanged.
--
-- Only rows with games: a row with none is the 1500/350 signup created and nothing else, which
-- is exactly what a missing row already means. Copying them would also make the first replay
-- after this migration report every one of them as "moved" (present before, absent after),
-- and that replay is the gate DEPLOY.md asks the operator to run.
INSERT INTO season_ratings (user_id, mode, season, rating, rd, volatility, games_played, updated_at)
SELECT user_id, mode, 1, rating, rd, volatility, games_played, updated_at
  FROM elo_ratings
 WHERE games_played > 0;

-- ---------------------------------------------------------------------------
-- 2. matches(created_at) — the column that files a match into its season.
-- ---------------------------------------------------------------------------
-- A season's replay reads the matches stored since that season began; without this it scanned
-- the whole table, which never shrinks. The community totals' 30-day windows use it too.
CREATE INDEX IF NOT EXISTS idx_matches_created ON matches (created_at);

-- ---------------------------------------------------------------------------
-- 3. matches.rated for the rows from before migration 0006.
-- ---------------------------------------------------------------------------
-- Those rows carry rated = NULL, and the ladder replay recognised the ones that had scored by
-- their rating stamps — the very stamps the replay clears before rebuilding. A replay that
-- threw half-way therefore lost them for good. Saying it in the column the rest of the code
-- reads closes that, and changes no answer: the replay already counted exactly these.
UPDATE matches
   SET rated = 1
 WHERE rated IS NULL
   AND EXISTS (SELECT 1 FROM match_participants p
                WHERE p.match_id = matches.id AND p.rating_after IS NOT NULL);
