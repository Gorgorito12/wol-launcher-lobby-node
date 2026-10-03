-- Monthly highlights read rated matches by month.
--
-- This file's own `_migrations.applied_at` is also the EPOCH for the automatic Discord post:
-- only a month that ENDED after this ran is ever posted on its own, so deploying in October does
-- not post September out of nowhere (src/stats/highlightsAnnounce.ts). Same idiom as founding's.
CREATE INDEX IF NOT EXISTS idx_matches_rated_created ON matches (rated, created_at);
