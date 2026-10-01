/**
 * The badge preference (design handoff 51c). Run: `npm test`.
 *
 * <p>Pinned here because none of it shows on the server's own surface: a wrong default reads as
 * a silently changed badge on every launcher, a widened accepted set lets a client store a value
 * no launcher can draw, and an inner join in the hello throws people out of their room.</p>
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BADGE_MODES, teamBadgeEligibleSql, normalizeBadgeMode, parseBadgeMode } from "./badgeMode.js";
import { LADDER_WHERE } from "../stats/rest.js";
import { MEMBER_HELLO_SQL } from "../lobbies/LobbyRoom.js";

test("the endpoint accepts exactly the three modes", () => {
    assert.deepEqual([...BADGE_MODES], ["highest", "1v1", "team"]);
    for (const m of BADGE_MODES) assert.equal(parseBadgeMode(m), m);
});

test("the ladder's own word for 1v1 is NOT a badge mode", () => {
    // 'default' beside 'highest' reads as "the default preference" — the misreading this
    // vocabulary was chosen to avoid — so it must be a 400, not quietly accepted.
    for (const bad of ["default", "Team", "1V1", "", " team", null, undefined, 1, {}]) {
        assert.equal(parseBadgeMode(bad), null, `accepted ${JSON.stringify(bad)}`);
    }
});

test("every read falls back to highest", () => {
    assert.equal(normalizeBadgeMode(null), "highest");
    assert.equal(normalizeBadgeMode("x"), "highest");
    assert.equal(normalizeBadgeMode("team"), "team");
});

test("THE ONE THAT MATTERS: an existing player reads as Highest, never NULL", () => {
    const sql = readFileSync(join(process.cwd(), "migrations", "0023_badge_mode.sql"), "utf8");
    assert.match(sql, /ADD COLUMN badge_mode TEXT NOT NULL DEFAULT 'highest'/);
});

test("unlocking Teams asks the ladder's own question", () => {
    // Two copies of "who is on the team ladder" drift; then the selector unlocks a badge the
    // ladder draws as Discovery.
    const sql = teamBadgeEligibleSql();
    assert.ok(sql.includes(LADDER_WHERE), sql);
});

test("the hello's rating joins stay LEFT — it is the membership check", () => {
    const left = MEMBER_HELLO_SQL.match(/LEFT JOIN elo_ratings/g) ?? [];
    assert.equal(left.length, 2, MEMBER_HELLO_SQL);
    assert.match(MEMBER_HELLO_SQL, /mode = 'default'/);
    assert.match(MEMBER_HELLO_SQL, /mode = 'team'/);
    // A bare JOIN would throw everyone without a team rating — nearly everyone — out of
    // their room with 4004.
    assert.equal(/(^|[^T])\s+JOIN elo_ratings/.test(MEMBER_HELLO_SQL.replace(/LEFT JOIN elo_ratings/g, "")), false);
});
