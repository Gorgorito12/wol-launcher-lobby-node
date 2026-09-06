/**
 * The error whose MESSAGE is the whole user interface. Run: `npm test`.
 *
 * <p>Almost every error here is localised by the launcher from its <c>code</c>, so the English
 * sentence is only a fallback nobody reads. <c>launcher_too_old</c> is the exception, and it is
 * the exception by construction: the clients it refuses are the ones too old to know the code.
 * Checked tag by tag — <c>X-Launcher-Version</c> and the <c>launcher_too_old</c> handling both
 * arrive in v1.0.13, so everything at v1.0.12e or below both fails the minimum automatically and
 * has no idea what the code means. What those launchers put on screen is <c>ex.Message</c>,
 * verbatim: <c>CreateLobbyDialog.CreateButton_Click</c> calls <c>ShowError(ex.Message)</c>, and
 * the join path uses it as the body of its notice.</p>
 *
 * <p>So this string is the only thing that population can ever be told, and it cannot be fixed
 * for them later by shipping a launcher — they are refused precisely because they will not take
 * one. Hence both languages, and hence a test: nobody looks at this line again until the day the
 * minimum is switched on, which is the day it is the only thing that matters.</p>
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Errors } from "./errors.js";

test("THE_ONE_THAT_MATTERS_TheTooOldMessageIsReadableInBothLanguages", () => {
    const err = Errors.LauncherTooOld("v1.0.14a");

    // Spanish first: most of this community reads it, and the launcher's own default is es.
    assert.ok(
        /demasiado antiguo/i.test(err.message),
        `the refusal has no Spanish half, so most of the players it turns away cannot read `
        + `it: ${err.message}`,
    );
    assert.ok(
        /too old/i.test(err.message),
        `the refusal lost its English half: ${err.message}`,
    );

    // It has to say what to DO. "You are too old" without "update" is a dead end for somebody
    // whose launcher will not open the update dialog by itself.
    assert.ok(/Actual[ií]zalo/i.test(err.message) && /[Uu]pdate/.test(err.message), err.message);
});

test("the shape the launcher parses is untouched", () => {
    const err = Errors.LauncherTooOld("v1.0.14a");

    // 426 Upgrade Required, and the code is what a MODERN launcher localises from - it never
    // shows the sentence above. Change either and the good path breaks to fix the sad one.
    assert.equal(err.status, 426);
    assert.equal(err.code, "launcher_too_old");

    // The required version travels in the payload so the launcher can NAME it rather than
    // saying "too old" and leaving somebody to work out what to do.
    assert.deepEqual(err.details, { min_version: "v1.0.14a" });
});
