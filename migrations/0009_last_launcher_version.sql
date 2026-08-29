-- Which launcher build each player last used.
--
-- Written so an operator can answer ONE question before turning on a minimum-version
-- requirement: how many people would that lock out? Without it, setting MIN_LAUNCHER_VERSION is
-- a blind shot — and the failure mode of guessing high is that everybody loses multiplayer at
-- once, which is exactly the kind of thing you only discover from complaints.
--
-- Telemetry, never a gate: the check itself reads the header on the request, not this column. A
-- NULL simply means we have not seen that player since clients started reporting it.
ALTER TABLE users ADD COLUMN last_launcher_version TEXT;
