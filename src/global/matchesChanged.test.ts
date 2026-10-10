/**
 * The `matches_changed` frame's batching. Run: `npm test`.
 *
 * <p>Every open launcher refreshes when it gets this frame, so the frame's count IS the number of
 * request bursts the server takes. One report is routinely followed within a second by its late
 * rating and a civilization filled in from a confirmation; batching is what makes that one burst
 * instead of three — and what must never let a burst postpone the frame for ever.</p>
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MatchesChangedBatcher, type MatchesChangedFrame } from "./matchesChanged.js";

function manual() {
    const sent: MatchesChangedFrame[] = [];
    const scheduled: (() => void)[] = [];
    const batcher = new MatchesChangedBatcher((f) => sent.push(f), 1000, (fn) => { scheduled.push(fn); return 0; });
    return { sent, scheduled, batcher };
}

test("THE_ONE_THAT_MATTERS_ChangesInsideTheSecondGoOutAsOneFrame", () => {
    const { sent, scheduled, batcher } = manual();
    batcher.add("m1", ["a", "b"]);
    batcher.add("m1", ["a", "b"]);   // its late rating
    batcher.add("m2", ["c"]);

    assert.equal(scheduled.length, 1, "only the first note schedules; later ones join it");
    assert.equal(sent.length, 0, "nothing goes out before the delay");

    scheduled[0]!();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.type, "matches_changed");
    assert.deepEqual([...sent[0]!.matchIds].sort(), ["m1", "m2"]);
    assert.deepEqual([...sent[0]!.userIds].sort(), ["a", "b", "c"]);
});

test("AfterAFrameTheNextChangeSchedulesAgain", () => {
    const { sent, scheduled, batcher } = manual();
    batcher.add("m1", ["a"]);
    scheduled[0]!();
    batcher.add("m2", ["b"]);
    assert.equal(scheduled.length, 2);
    scheduled[1]!();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1]!.matchIds, ["m2"]);
    assert.deepEqual(sent[1]!.userIds, ["b"], "the previous frame's ids are not sent again");
});

test("ANoteWithoutAMatchSendsNothing_AndAFailingSendNeverThrows", () => {
    const { sent, scheduled, batcher } = manual();
    batcher.add("", ["a"]);
    assert.equal(scheduled.length, 0);
    batcher.flush();
    assert.equal(sent.length, 0);

    const throwing = new MatchesChangedBatcher(() => { throw new Error("socket gone"); }, 1000, (fn) => { fn(); return 0; });
    assert.doesNotThrow(() => throwing.add("m1", ["a"]));
});
