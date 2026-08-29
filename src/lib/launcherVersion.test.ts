/**
 * The version comparison that decides who may play. Run: `npm test`.
 *
 * <p>Two ways to get this wrong, and both are worse than having no check at all: order the
 * letter suffix wrongly and the NEWEST clients are the ones refused, or treat "no minimum
 * configured" as a refusal and everybody is locked out at once.</p>
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseLauncherVersion, compareLauncherVersions, meetsMinimum } from "./launcherVersion.js";

function v(tag: string) {
  const parsed = parseLauncherVersion(tag);
  assert.ok(parsed, `expected ${tag} to parse`);
  return parsed;
}

test("a plain tag parses, with or without the v", () => {
  assert.deepEqual(v("v1.0.12"), { major: 1, minor: 0, patch: 12, letter: 0 });
  assert.deepEqual(v("1.0.12"), { major: 1, minor: 0, patch: 12, letter: 0 });
});

test("a missing patch reads as zero", () => {
  assert.deepEqual(v("v2.3"), { major: 2, minor: 3, patch: 0, letter: 0 });
});

// THE ORDERING THAT MATTERS. The project ships v1.0.12e and friends, and the letter is a suffix
// WITHIN a patch — not a prerelease marker. Invert it and the newest clients get refused.
test("the letter suffix sorts AFTER the plain patch, and in order", () => {
  const asc = ["1.0.5", "1.0.5a", "1.0.5b", "1.0.5z", "1.0.5aa", "1.0.6"];
  for (let i = 1; i < asc.length; i++) {
    assert.ok(
      compareLauncherVersions(v(asc[i]!), v(asc[i - 1]!)) > 0,
      `${asc[i]} should be newer than ${asc[i - 1]}`,
    );
  }
});

test("the letter is compared case-insensitively", () => {
  assert.equal(compareLauncherVersions(v("1.0.5E"), v("1.0.5e")), 0);
});

test("garbage does not parse", () => {
  for (const bad of ["", "  ", "latest", "v", "1", "1.x.0", "v1.0.0-rc1", null, undefined]) {
    assert.equal(parseLauncherVersion(bad as string), null, `${bad} should not parse`);
  }
});

// --- meetsMinimum ------------------------------------------------------------

/**
 * <b>The default, and the most important case in the file.</b> No minimum configured means the
 * whole feature is off. Getting this backwards locks every player out of multiplayer the moment
 * the server starts.
 */
test("no minimum configured lets everybody in", () => {
  for (const client of ["v1.0.1", "v9.9.9", "", null, undefined, "nonsense"]) {
    assert.equal(meetsMinimum(client as string, ""), true);
  }
});

test("an unusable minimum is treated as no minimum, not as a wall", () => {
  assert.equal(meetsMinimum("v1.0.1", "latest"), true);
});

test("the same version, and anything newer, is allowed", () => {
  assert.equal(meetsMinimum("v1.0.13", "v1.0.13"), true);
  assert.equal(meetsMinimum("v1.0.13a", "v1.0.13"), true);
  assert.equal(meetsMinimum("v1.1.0", "v1.0.13"), true);
});

test("anything older is refused", () => {
  assert.equal(meetsMinimum("v1.0.12e", "v1.0.13"), false);
  assert.equal(meetsMinimum("v1.0.13", "v1.0.13a"), false);
  assert.equal(meetsMinimum("v0.9.9", "v1.0.0"), false);
});

/**
 * A client that reports nothing can only be a build from before clients reported it — which is
 * precisely the population a minimum exists to exclude. Note the asymmetry with the test above:
 * this refuses ONLY because a minimum is set.
 */
test("a client that reports no version fails a minimum, but only when one is set", () => {
  assert.equal(meetsMinimum(null, "v1.0.13"), false);
  assert.equal(meetsMinimum("", "v1.0.13"), false);
  assert.equal(meetsMinimum("Aoe3ModLauncher/1.0", "v1.0.13"), false);
  assert.equal(meetsMinimum(null, ""), true);
});
