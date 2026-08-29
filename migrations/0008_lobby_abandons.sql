-- Who walked out of a competitive match while it was still running.
--
-- The exploit this closes: the player who is losing closes the launcher, so the game never
-- writes an ending to the recording, so the report goes down as "nobody won" and he keeps
-- his rating. Reading the recording cannot fix that — there is nothing in it to read.
-- What CAN see it is the server, because it is the one holding the socket.
--
-- A ROW PER PLAYER, not a pair of columns on `lobbies`. In a 1v1 only one player can
-- meaningfully abandon, but a future 2v2 needs "did a whole team walk out", and that is a
-- question you can only ask of a set. Cheaper to shape it right once than to migrate the
-- semantics later.
--
-- `disconnected_at` is WHEN THE SOCKET DROPPED, and the row alone proves nothing: the
-- launcher's LobbyWebSocket reconnects on its own with backoff up to 30 s (see
-- orphanSweep.ts, which reasons about exactly this), so a dropped socket is not a
-- departure. The row is deleted the moment that user says hello again. Only a row that has
-- survived the reconnect grace counts, and the decision that reads it lives in
-- src/elo/abandon.ts.
--
-- ON DELETE CASCADE on the lobby: this is evidence about one room and is worthless without
-- it.
CREATE TABLE IF NOT EXISTS lobby_abandons (
    lobby_id        TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    disconnected_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (lobby_id, user_id),
    FOREIGN KEY (lobby_id) REFERENCES lobbies(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)  REFERENCES users(id)   ON DELETE CASCADE
);
