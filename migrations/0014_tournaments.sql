-- Single-elimination tournaments, solo and team, run by whoever creates them.
--
-- ---------------------------------------------------------------------------
-- Why the permission lives on THIS row and not on `users`
-- ---------------------------------------------------------------------------
-- There is no role column anywhere in this database and this migration does not add
-- one. A role would have to be GRANTED, and granting is the thing the maintainer
-- explicitly did not want to be doing. So the permission is ownership of a row:
-- whoever creates a tournament owns it and may do everything to it, and may do nothing
-- at all to anybody else's. It is the same shape as `lobbies.host_user_id` gating kick
-- and start, and it needs no administration.
--
-- `owner_user_id` is written once and never updated, like `lobbies.created_by` (0010) and
-- unlike `host_user_id`. A tournament does not migrate to a new owner when the old one
-- goes quiet; it goes stale and is archived (see `last_activity_at`).
--
-- ---------------------------------------------------------------------------
-- Why a bracket slot holds an ENTRANT and not a user
-- ---------------------------------------------------------------------------
-- A 1v1 slot holds a person and a 3v3 slot holds three. Modelling those as two different
-- things would mean two brackets, two advancement rules and two screens. An `entrant` is
-- the one abstraction that makes 1v1 a team tournament with teams of one, so every rule
-- below is written once.

CREATE TABLE tournaments (
    id            TEXT PRIMARY KEY,              -- shortId(8)
    name          TEXT NOT NULL,
    mod_id        TEXT NOT NULL,                 -- lowercased, compared against rankedModIds
    owner_user_id TEXT NOT NULL REFERENCES users(id),

    -- 2v2 and 3v3 are the only team shapes, and that is not a product choice: matchShape()
    -- only reads a winner out of 2, 4 or 6 participants, so a 4v4 could be played and
    -- never reported. Offering one would be offering a tournament that cannot finish.
    format        TEXT NOT NULL DEFAULT '1v1' CHECK (format IN ('1v1','2v2','3v3')),

    -- How teams are formed. 'solo' is the only legal value for a 1v1.
    --   registered - the captain enters a saved team
    --   adhoc      - the captain assembles a roster at registration time
    --   draft      - everyone registers alone and the owner merges them before seeding
    team_source   TEXT NOT NULL DEFAULT 'solo'
                  CHECK (team_source IN ('solo','registered','adhoc','draft')),

    -- open     - first come, first served; past capacity you land on the waitlist
    -- approval - everyone lands as 'pending' and the owner accepts or rejects
    entry_mode    TEXT NOT NULL DEFAULT 'open' CHECK (entry_mode IN ('open','approval')),

    -- 'abandoned' is NOT a synonym for finished. It crowns nobody, moves no rating and
    -- touches no bracket match; it only stops a forgotten tournament occupying a slot.
    -- See last_activity_at.
    status        TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','registration','ready','running',
                                    'finished','cancelled','abandoned')),

    -- Bo1 today. The column exists now so Bo3 is a code change: tournament_match_games
    -- already stores one row per game rather than folding the result into the match.
    best_of       INTEGER NOT NULL DEFAULT 1,

    -- Slots, counted in ENTRANTS and not in people: 8 slots of 3v3 is 24 players.
    -- Capped at 16 by the route, because a 16-entrant first round needs 8 simultaneous
    -- rooms and MAX_ACTIVE_GAMES is the whole server's budget.
    capacity      INTEGER NOT NULL DEFAULT 8,

    -- Denormalised count of CONFIRMED entrants. It exists to be claimed with a
    -- conditional UPDATE (`... WHERE confirmed_count < capacity`) rather than checked
    -- and then written, which is how the lobby seat cap leaks: it reads current_players,
    -- awaits three times, and only then inserts, so two players take the last seat.
    confirmed_count INTEGER NOT NULL DEFAULT 0,

    bracket_size  INTEGER,                       -- 2^ceil(log2(N)); NULL until start
    winner_entrant_id TEXT,                      -- no FK: survives entrant deletion

    -- Set ONLY by the maintainer's CLI. A user-created tournament never announces itself
    -- to Discord, because the announcement carries a role ping and that is the obvious
    -- thing to abuse when anybody can create a tournament.
    featured      INTEGER NOT NULL DEFAULT 0,

    created_at    TEXT NOT NULL DEFAULT (datetime('now')),

    -- What keeps a forgotten tournament from occupying a slot for ever. Stamped by every
    -- write that means somebody still cares: open, register, accept, seed, start, a
    -- reported match, a walkover, a disqualification.
    --
    -- Staleness is evaluated LAZILY - the public list filters on it and both creation
    -- caps ignore stale rows - so a dead tournament costs nothing BEFORE anything marks
    -- it. The startup sweep that flips it to 'abandoned' is tidiness, not correctness.
    -- That matters because this server has no periodic timer and must not grow one.
    last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),

    registration_opened_at TEXT,
    started_at    TEXT,
    finished_at   TEXT,
    cancelled_at  TEXT,
    abandoned_at  TEXT
);
CREATE INDEX idx_tournaments_owner ON tournaments (owner_user_id, status);
CREATE INDEX idx_tournaments_status ON tournaments (status, last_activity_at DESC);

-- One row per thing that occupies a bracket slot: a lone player, or a team.
CREATE TABLE tournament_entrants (
    id            TEXT PRIMARY KEY,              -- uuid
    tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('solo','team')),

    -- Set only when the entrant came from a saved team. NULL for 'adhoc' and 'draft'
    -- rosters, which exist only inside this tournament.
    team_id       TEXT REFERENCES teams(id),

    -- Frozen at registration. A saved team can be renamed or disbanded afterwards, and a
    -- finished bracket still has to render the name it was played under.
    display_name  TEXT NOT NULL,

    -- Who registered, and who may open the room for this entrant's matches. For a solo
    -- entrant this is the player themselves.
    captain_user_id TEXT NOT NULL REFERENCES users(id),

    seed          INTEGER,                       -- NULL until the owner seeds
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','confirmed','waitlist',
                                    'rejected','withdrawn','disqualified')),
    registered_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Ordered by registered_at because that is the waitlist order: whoever asked first is
-- whoever gets promoted first when a slot frees up.
CREATE INDEX idx_entrants_t ON tournament_entrants (tournament_id, status, registered_at);
CREATE INDEX idx_entrants_captain ON tournament_entrants (captain_user_id);

-- The roster, FROZEN at registration.
--
-- Copied rather than joined through team_id on purpose: a saved team can add or drop
-- players the day after entering, and the tournament has to remember who it accepted.
-- Same reason lobbies.roster_at_start is a snapshot instead of a live membership query.
CREATE TABLE tournament_entrant_members (
    entrant_id TEXT NOT NULL REFERENCES tournament_entrants(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id),
    PRIMARY KEY (entrant_id, user_id)
);
CREATE INDEX idx_entrant_members_user ON tournament_entrant_members (user_id);

-- One row per bracket slot pairing, created up front by tournament:start.
--
-- next_match_id / next_slot are MATERIALISED rather than derived from (round, position)
-- at read time. The arithmetic is trivial - (r,p) feeds (r+1, p>>1) at slot (p&1)+1 -
-- but the advancement hook runs inside the match-report path, where a bug is expensive
-- and a link that was written once and tested once is cheaper to trust than a formula
-- recomputed on every report. UNIQUE (tournament_id, round, position) keeps the two
-- consistent and makes a wrong link findable with one query.
CREATE TABLE tournament_matches (
    id              TEXT PRIMARY KEY,            -- uuid
    tournament_id   TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    round           INTEGER NOT NULL,            -- 1 = first round; the final is rounds_total
    position        INTEGER NOT NULL,            -- 0-based within the round
    entrant1_id     TEXT REFERENCES tournament_entrants(id),
    entrant2_id     TEXT REFERENCES tournament_entrants(id),
    winner_entrant_id TEXT REFERENCES tournament_entrants(id),
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','bye')),
    outcome         TEXT CHECK (outcome IN ('played','walkover','dq','bye')),

    -- The game that decided it. NULL for a walkover, a disqualification or a bye - which
    -- is exactly how you tell "nobody played this" from "somebody won this".
    match_id        TEXT REFERENCES matches(id),

    -- Reporter user id, or a sentinel: 'owner' (the tournament owner ruled),
    -- 'operator' (the maintainer's CLI), 'bye'. Same convention as matches.decided_by,
    -- which already carries 'abandon' and 'operator' alongside real user ids.
    decided_by      TEXT,
    decided_at      TEXT,

    next_match_id   TEXT REFERENCES tournament_matches(id),
    next_slot       INTEGER CHECK (next_slot IN (1,2)),
    UNIQUE (tournament_id, round, position)
);
CREATE INDEX idx_tmatches_t ON tournament_matches (tournament_id, round, position);

-- One row per reported game inside a bracket match.
--
-- Bo1 writes exactly one and could have stored it in tournament_matches.match_id alone.
-- This table exists NOW so that best_of 3 is a code change and not a migration on a
-- table that by then has live tournaments in it.
CREATE TABLE tournament_match_games (
    tournament_match_id TEXT NOT NULL REFERENCES tournament_matches(id) ON DELETE CASCADE,
    match_id            TEXT NOT NULL REFERENCES matches(id),
    game_no             INTEGER NOT NULL DEFAULT 1,
    winner_entrant_id   TEXT,
    PRIMARY KEY (tournament_match_id, match_id)
);

-- THE BINDING between a room and a bracket slot.
--
-- Same rule as lobbies.competitive (0007), for the same reason: the server decides it
-- before the game and POST /matches reads it off this row, so the client can never claim
-- that a game it just played was a tournament match. It is written only by
-- POST /tournaments/:id/matches/:mid/lobby.
ALTER TABLE lobbies ADD COLUMN tournament_match_id TEXT;
CREATE INDEX idx_lobbies_tournament_match ON lobbies (tournament_match_id)
    WHERE tournament_match_id IS NOT NULL;
