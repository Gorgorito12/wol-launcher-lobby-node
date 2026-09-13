/**
 * Whether the way a game closed was a CRASH — derived on the server from the four signals
 * the launcher sends with `game_exit_evidence`, never taken from a flag the client asserts.
 *
 * <p><b>What separates a crash from a dodge.</b> "The game closed with no ending in the
 * recording" is produced identically by a crash and by `taskkill`. What a player cannot
 * fabricate with a click is what a real crash leaves in the operating system: an
 * Application Error 1000 event naming the executable, the faulting module and an NTSTATUS
 * exception code. A terminated process leaves none of that, and its exit code is 1 or -1
 * rather than a failure status. The launcher reads the event log and the exit code; this
 * decides.</p>
 *
 * <p><b>The event is the strong signal and the one the server cannot check.</b> A patched
 * launcher could claim one. That is bounded by two things rather than closed: forging it
 * takes code, not a click — a real access violation has to be injected into the process for
 * the event to exist at all — and the budget in `crashVoid.ts` caps what it can buy at one
 * voided loss per player per window.</p>
 *
 * <p>Pure and side-effect free.</p>
 */

export type RecordingOutcome = 'present' | 'absent' | 'unknown';

export interface CrashSignals {
    /** `Process.ExitCode`, or null when the launcher had no handle to read it from. */
    exitCode: number | null;
    /** Whether the player's OWN recording carries the outcome trailer. */
    recordingOutcome: RecordingOutcome;
    /** The launcher itself killed the game. */
    stoppedByUser: boolean;
    /** The launcher found a Windows Application Error 1000 event for the exe, inside the
     *  match's window and, where the pid was known, for that pid. */
    eventSeen: boolean;
}

/**
 * NTSTATUS failure: severity bits 11 (0xC0000000 and above). Read as an unsigned 32-bit
 * value, because .NET hands the code back as a signed int — 0xC0000005 arrives as
 * -1073741819.
 *
 * <p><b>0xFFFFFFFF is excluded by name.</b> It sits above the threshold but it is not a
 * status the kernel ever raises: it is the -1 that .NET's <c>Process.Kill()</c> and several
 * tools pass to <c>TerminateProcess</c>. The one exit code a launcher-killed or tool-killed
 * game reliably carries must not read as a crash.</p>
 */
export function isNtstatusFailure(code: number): boolean {
    if (!Number.isFinite(code)) return false;
    const u = code >>> 0;
    return u >= 0xC0000000 && u !== 0xFFFFFFFF;
}

/**
 * All four, and the order they are written in is the order they matter: the event proves a
 * crash happened, the missing ending proves the crash is what ended the match, the user not
 * having stopped it rules out the launcher's own kill, and the exit code is allowed to be
 * unknown because the elevated launch path has no handle to read it from.
 */
export function verifyCrash(s: CrashSignals): boolean {
    if (!s.eventSeen) return false;
    if (s.recordingOutcome !== 'absent') return false;
    if (s.stoppedByUser) return false;
    if (s.exitCode !== null && !isNtstatusFailure(s.exitCode)) return false;
    return true;
}

/** Accept only the three words the launcher may send; anything else is 'unknown'. */
export function normaliseRecordingOutcome(raw: unknown): RecordingOutcome {
    return raw === 'present' || raw === 'absent' ? raw : 'unknown';
}
