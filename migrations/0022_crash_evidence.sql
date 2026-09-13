-- HOW a player's game closed, and the one consequence it may have.
--
-- `lobby_game_exits` (0020) records THAT a game closed. This adds what the launcher could see
-- about the closing, sent in a second frame (`game_exit_evidence`) once the recording has
-- been read — the first frame is a timestamp and must not wait for any of this:
--
--   exit_code         Process.ExitCode of age3y.exe. A crash is an NTSTATUS failure
--                     (0xC0000005 access violation, 0xC000001D illegal instruction,
--                     0xC00000FD stack overflow…); a normal close is 0; `taskkill` and Task
--                     Manager are 1 / -1. NULL when the launcher had no handle (the elevated
--                     launch path).
--   recording_outcome 'present' | 'absent' | 'unknown' — whether the player's OWN recording
--                     carries the outcome trailer. A killed process never writes one.
--   stopped_by_user   the launcher itself killed the game (Stop button, leaving the room,
--                     quitting the launcher). Never a crash.
--   crash_verified    the SERVER's derivation from the four signals (src/elo/crashEvidence.ts):
--                     a Windows Application Error 1000 event for the exe was seen by the
--                     launcher, the recording has no ending, the user did not stop it, and the
--                     exit code is a failure or unknown. The event is the strong signal — a
--                     `taskkill` leaves none — and the one part the server cannot check itself.
--   crash_module      the faulting module the event named. Diagnostic only.
--
-- `matches.crashed_user_id` names the player whose verified crash VOIDED the match
-- (`unrated_reason = 'game_crashed'`, src/elo/crashVoid.ts). It is what the per-player budget
-- counts: a verified crash voids a rated 1v1 at most CRASH_VOID_PER_WINDOW times per
-- CRASH_VOID_WINDOW_SECONDS per player; past that the standard bargain applies and the crash
-- is a loss. Only ever VOIDS, never flips a result, and never a tournament match.
ALTER TABLE lobby_game_exits ADD COLUMN exit_code INTEGER;
ALTER TABLE lobby_game_exits ADD COLUMN recording_outcome TEXT;
ALTER TABLE lobby_game_exits ADD COLUMN stopped_by_user INTEGER;
ALTER TABLE lobby_game_exits ADD COLUMN crash_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lobby_game_exits ADD COLUMN crash_module TEXT;
ALTER TABLE matches ADD COLUMN crashed_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_matches_crashed ON matches (crashed_user_id, created_at DESC);
