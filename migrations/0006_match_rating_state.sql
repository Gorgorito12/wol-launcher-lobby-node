-- Persist WHY a match did or did not score, and the evidence comparison.
--
-- Until now `rated` / `unrated_reason` were computed at report time, returned on the wire
-- and logged — but never stored. So a match that went down undecided could not be
-- re-examined afterwards, which is what made a correction impossible: the row simply did
-- not remember that it was waiting for one.
--
-- Both columns are NULL on every EXISTING row, and the upgrade rule only ever acts on
-- `unrated_reason = 'no_decided_result'`. Old history is therefore inelegible by
-- construction — there is no path by which this can re-rate a match that already scored.
ALTER TABLE matches ADD COLUMN unrated_reason TEXT;

-- NULL = a row from before this migration, 0 = stored unrated, 1 = rated.
--
-- Needed because `unrated_reason IS NULL` alone means BOTH "it scored" and "we don't know",
-- and that ambiguity would poison the very statistics collected below.
ALTER TABLE matches ADD COLUMN rated INTEGER;

-- Who decided a match after the fact, when one did. Audit trail: a correction moves real
-- rating points, and without this there is no way to ask which ones.
ALTER TABLE matches ADD COLUMN decided_by TEXT;

-- The comparison verdict, today written only to the server log — which rotates, and is
-- gone. This is the number that decides whether agreement between the two players can ever
-- be REQUIRED, and 0004 created match_confirmations expressly to collect it; leaving it in
-- a log meant it was never actually accumulating anywhere it could be counted.
--
-- 'agree' | 'disagree' | 'inconclusive' | 'not_reported'
ALTER TABLE match_confirmations ADD COLUMN agreement TEXT;
-- 'true' | 'false' | 'unknown' — whether both sides read the same game (by seed).
ALTER TABLE match_confirmations ADD COLUMN same_game TEXT;
