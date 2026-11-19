-- What the rating engine knew about each player when it rated a match (2026-11-18).
--
-- win_expected: his side's chance of winning, 1-99, from the ratings BEFORE the match — what the
-- result card explains the points with ("+6: you were the favourite, 72 %"). Sent to its owner
-- only, and never when another participant's rating is hidden (src/elo/placementPrivacy.ts).
--
-- rd_before: his rating deviation at the time, so a tournament performance can use each rival's
-- Glicko expectation as it stood that day (src/tournaments/performance.ts).
--
-- Both written by rateStoredMatch, the only writer; NULL for matches rated before this, which
-- simply carry no explanation (or the plain curve) until an elo:recompute --apply.
ALTER TABLE match_participants ADD COLUMN win_expected INTEGER;
ALTER TABLE match_participants ADD COLUMN rd_before REAL;
