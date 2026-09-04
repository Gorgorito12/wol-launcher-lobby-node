-- Co-organisers: people the OWNER of a tournament lets help run it.
--
-- ---------------------------------------------------------------------------
-- This argues with 0014, on purpose
-- ---------------------------------------------------------------------------
-- 0014's header says "there is no role column anywhere in this database and this
-- migration does not add one", because "a role would have to be GRANTED, and granting is
-- the thing the maintainer explicitly did not want to be doing". That reasoning was about
-- a GLOBAL role -- a moderator, a staff flag on `users` -- and it still holds: there is
-- no such column here and this migration does not add one either.
--
-- What this adds is narrower and is granted by somebody else entirely. The permission is
-- still per tournament, and the person who hands it out is that tournament's OWNER, never
-- the maintainer. Nobody has to administer anything: a tournament with no rows here
-- behaves exactly as it did before, and a tournament's grants die with it.
--
-- ---------------------------------------------------------------------------
-- What a manager may and may not do
-- ---------------------------------------------------------------------------
-- Everything the owner may do to the bracket -- open and close registration, accept and
-- reject, seed, start, award a match, disqualify -- and two things they may not:
--
--   * CANCEL the tournament. It is irreversible and it is the owner's alone.
--   * APPOINT another manager. `tournament:transfer` is a maintainer command precisely
--     because "a tournament you can give away is a tournament somebody can be talked into
--     giving away"; a manager who can appoint managers is that same hole with more steps.
--
-- Both limits live in the ROUTE guards (`cancel` and the two manager routes keep
-- `requireTournamentOwner`), not in this schema. A row here means "may help run it".
--
-- `added_by` is kept for the same reason `lobbies.created_by` is: when something goes
-- wrong in a bracket, the first question is who let that person near it.
CREATE TABLE tournament_managers (
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES users(id),
    added_by      TEXT NOT NULL REFERENCES users(id),
    added_at      TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tournament_id, user_id)
);

-- The composite primary key already serves the guard's read, which is always
-- (tournament_id, user_id) -- one row, on every write route a manager touches. This index
-- serves the other direction: "which tournaments do I help run", which is what a launcher
-- would ask to mark them in a list.
CREATE INDEX idx_tournament_managers_user ON tournament_managers (user_id);
