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
import { LOBBY_LIST_SQL } from "../lobbies/rest.js";

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

test("THE HELLO CARRIES NO RATING JOIN — it is the membership check", () => {
    // A row here means "you are in this lobby". A join on a ratings table could only duplicate
    // the member or, mis-bound, answer 4004 not_in_lobby for everyone. The ratings are read
    // separately (effectiveRatings), and a failure there costs a number, never the room.
    // It DOES read the member's role and team, which are lobby_members' own columns.
    assert.doesNotMatch(MEMBER_HELLO_SQL, /elo_ratings|season_ratings|player_ratings/);
    assert.match(MEMBER_HELLO_SQL, /FROM lobby_members lm/);
    assert.match(MEMBER_HELLO_SQL, /lm\.lobby_id = \? AND lm\.user_id = \?/);
    assert.match(MEMBER_HELLO_SQL, /lm\.team/);
});

test("the rooms list carries no rating join either", () => {
    // Same reason as the hello: a host with no rating row would vanish from an inner join.
    assert.doesNotMatch(LOBBY_LIST_SQL, /elo_ratings|season_ratings|player_ratings/);
    assert.match(LOBBY_LIST_SQL, /FROM lobbies l/);
});

test("unlocking Teams asks the TEAM ladder: finished team placement", () => {
    // Choosing the Teams badge is possible exactly when the team ladder ranks the player, i.e.
    // after five rated team matches. Before that the badge would read as Discovery.
    const sql = teamBadgeEligibleSql();
    assert.match(sql, /FROM player_ratings e/);
    assert.ok(sql.includes(LADDER_WHERE), sql);
});
