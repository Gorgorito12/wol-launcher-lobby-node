-- The CIVILIZATIONS a confirmation read from its own recording.
--
-- Only the host's FIRST-PASS report ever carried a civilization. That pass reads the
-- recording once, immediately, and reports; when the game writes the file a few seconds
-- later — which is the ordinary case, and the reason most results still end up decided —
-- the late reading goes out through POST /matches/confirm, which had no civ field, and
-- nothing on this side ever wrote `match_participants.civ` after the INSERT. So a match
-- whose recording arrived late stayed civ-less for good. Measured on the live server the
-- day this was written: 43 of 44 matches, including every one played that morning.
--
-- The confirmation now carries what its recording said about EVERY player, as two JSON
-- objects keyed by user id ({"<user_id>": "Ethiopians"}), and the server fills the gaps
-- in `match_participants` — civ and home_city where they are NULL or blank — from any
-- confirmation for the same lobby, whichever arrives first. Fill gaps ONLY: the host's
-- report is never overwritten, so a confirmer cannot repaint a match that already knows.
--
-- JSON in a TEXT column rather than a table of its own because a confirmation is one row
-- per (lobby, user) and these are two words per participant; they are read exactly once,
-- when the gap-fill runs, and never queried across rows.
--
-- NULL means the confirming launcher predates this, or its recording named nobody the
-- room's roster could be joined to (see MatchSlotMap in the launcher).

ALTER TABLE match_confirmations ADD COLUMN civs TEXT;
ALTER TABLE match_confirmations ADD COLUMN home_cities TEXT;
