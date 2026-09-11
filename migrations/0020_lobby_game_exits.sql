-- Whose GAME closed while a competitive match was running.
--
-- The exploit this closes, and it is the second half of the one 0008 closed: the player who
-- is losing closes Age of Empires III — not the launcher, just the game. His launcher stays
-- connected, so no `lobby_abandons` row is ever written, so decideByAbandon answers "nobody
-- abandoned". His own engine wrote no recording (a terminated process writes nothing), and
-- the opponent's recording, which names him the loser, is refused as a claimed VICTORY with
-- no host fingerprint to match. The match goes down a draw and he keeps his rating.
--
-- A SEPARATE TABLE FROM `lobby_abandons`, for two reasons and not for tidiness:
--
--   1. `lobby_abandons` rows are DELETED when their owner says hello again, because a
--      dropped socket reconnects. A closed game does not: AoE3 has no rejoin, so once the
--      process is gone that player is out of that match for good. A row here must survive
--      every reconnect the launcher makes afterwards, and it would not survive in there.
--   2. It records a different fact, with a field the socket could never supply.
--
-- `exited_at` is the SERVER's clock at the moment the frame arrives, and the verdict uses
-- it. The launcher sends the frame before it does anything else with the exit — before it
-- reads the recording, before it reports — so the two are under a second apart, which is
-- nothing against a five-minute threshold. `client_seconds` is what the launcher said its
-- own match had lasted: kept for `admin.ts match:show` and for spotting a broken clock,
-- never for deciding anything. The client is what an attacker controls.
--
-- INSERT OR IGNORE, so the FIRST exit is the one that counts: reopening the game and closing
-- it again cannot move the mark later into the match and out of forfeit range.
--
-- ON DELETE CASCADE on the lobby: this is evidence about one room and is worthless without
-- it.
CREATE TABLE IF NOT EXISTS lobby_game_exits (
    lobby_id       TEXT NOT NULL,
    user_id        TEXT NOT NULL,
    exited_at      TEXT NOT NULL DEFAULT (datetime('now')),
    client_seconds INTEGER,
    PRIMARY KEY (lobby_id, user_id),
    FOREIGN KEY (lobby_id) REFERENCES lobbies(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)  REFERENCES users(id)   ON DELETE CASCADE
);
