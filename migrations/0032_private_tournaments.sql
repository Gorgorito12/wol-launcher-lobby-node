-- Private tournaments (2026-11-13).
--
-- tournaments.visibility   'public' (every tournament before this) or 'private'. A private one is
--                          never in the public list, its detail answers 404 to a stranger, and the
--                          rooms of its matches are left out of GET /lobbies and every announcement.
--                          Its owner, co-organisers and entrants see it in the `mine` part of the
--                          list, in every state, finished included.
-- tournaments.invite_code  set only on a private one: how somebody who is not in it yet finds it
--                          (GET /tournaments/by-code/:code) and enters it. Shown only to the owner
--                          and the co-organisers. Unique while set.
ALTER TABLE tournaments ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public','private'));
ALTER TABLE tournaments ADD COLUMN invite_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tournaments_invite_code
    ON tournaments (invite_code) WHERE invite_code IS NOT NULL;
