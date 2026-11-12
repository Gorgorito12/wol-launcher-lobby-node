-- Teams chosen in the ROOM (2v2 / 3v3): each player picks Team 1 or Team 2, the host may move
-- anybody. Until now sides existed only inside Age of Empires III and were recovered from the
-- recording after the fact.
--
-- lobby_members.team       1, 2, or NULL (no team yet). Reset when a player (re)joins.
-- lobbies.teams_at_start   JSON {user_id: 1|2}, frozen at Start beside roster_at_start, or NULL
--                          when the room did not use room teams (a 1v1, or an older launcher).
-- matches.room_teams       the same JSON, copied at report time so a later restart of the room
--                          cannot rewrite what this match was promised. A recording whose
--                          sides differ from it is stored `teams_mismatch`.
ALTER TABLE lobby_members ADD COLUMN team INTEGER CHECK (team IN (1, 2));
ALTER TABLE lobbies ADD COLUMN teams_at_start TEXT;
ALTER TABLE matches ADD COLUMN room_teams TEXT;
