-- The match's own fingerprint, read out of the recording.
--
-- Two keys the .age3Yrec settings dictionary has carried all along:
--   gamerandomseed  the map seed
--   gamehosttime    the host's clock at start
--
-- The seed is the number that makes every machine generate the same map, so BOTH
-- players of one game carry it and two different games do not. That gives two
-- things nothing else could:
--
--   1. Whether the host and their opponent read the SAME match — checked without
--      comparing a single name. Matching AoE3 profile names was the obvious idea
--      and was rejected: they are frequently nothing like the Discord account, and
--      changing them in AoE3 barely works.
--   2. An anti-reuse key that identifies the GAME rather than the FILE. The
--      SHA-256 in 0003 is defeated by re-packing the recording; this is not.
--
-- Measured on six real recordings: six different seeds — including two back-to-back
-- games by the same host, host clocks fifteen apart, seeds 22235 and 15346. Neither
-- a name nor a timestamp separates that pair; the seed does.
--
-- BOTH columns, never the seed alone: the largest value seen is 32747, so it is
-- about 15 bits. On its own it would collide across unrelated matches; with the
-- host clock, two distinct games would have to share a seed AND a millisecond.
--
-- The index is PARTIAL and the launcher sends NULL rather than 0 when the recording
-- did not carry them, so a scenario or an unreadable field can never block a
-- legitimate report — the same shape as the replay-hash index in 0003.
ALTER TABLE matches ADD COLUMN game_seed INTEGER;
ALTER TABLE matches ADD COLUMN game_host_time INTEGER;

CREATE UNIQUE INDEX idx_matches_game_fingerprint
    ON matches (game_seed, game_host_time)
    WHERE game_seed IS NOT NULL;

-- The same pair on the opponent's reading, so the two can be compared.
ALTER TABLE match_confirmations ADD COLUMN game_seed INTEGER;
ALTER TABLE match_confirmations ADD COLUMN game_host_time INTEGER;
