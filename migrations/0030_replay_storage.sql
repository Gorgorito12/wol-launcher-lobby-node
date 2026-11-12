-- Competitive match recordings in an S3-compatible bucket (Oracle Object Storage).
--
-- The launcher of the player who reported a competitive match uploads its .age3Yrec straight
-- to the bucket through a presigned URL; this server never sees the bytes. These columns are
-- written by POST /replays/confirm once the object is verified to exist, and read by the
-- history (has_replay) and by GET /matches/:id/replay-url.
--
-- replay_object_key (0001) is left alone: it belonged to the old local-disk upload, is NULL on
-- every row, and is still emitted by the history for launchers that predate has_replay.

ALTER TABLE matches ADD COLUMN replay_key TEXT;           -- object key in the bucket, NULL until uploaded
ALTER TABLE matches ADD COLUMN replay_size_bytes INTEGER; -- size the bucket reported at confirm time
ALTER TABLE matches ADD COLUMN replay_uploaded_at TEXT;   -- datetime('now') at confirm time (UTC)
ALTER TABLE matches ADD COLUMN replay_uploader_id TEXT;   -- user who uploaded it (the reporter)
