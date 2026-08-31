/**
 * Whether walking out of a competitive match decides it — and, when it does not, why.
 *
 * <p><b>What this exists for.</b> The player who is losing closes his launcher. The game
 * never writes an ending to the recording, so the report goes down as "nobody won", and he
 * keeps his rating. No amount of reading the file can fix that: there is nothing in it to
 * read. The one witness is the server, which was holding his socket.</p>
 *
 * <p><b>This is the only rule in the project that moves rating from an ABSENCE of
 * evidence</b>, so every clause below is a brake rather than a feature. It is defensible
 * because it is the universal convention of competitive ladders — a disconnect is a loss —
 * and because the host agrees to it in writing before the room exists. It is NOT defensible
 * as a default, which is why it only ever applies to a competitive room.</p>
 *
 * <p>Pure and side-effect free: the caller does the I/O and hands in plain data.</p>
 */

/**
 * How long before the report a player's connection must have died to count as walking out.
 *
 * <p><b>What this actually separates is "closed it when the game ended" from "walked out
 * mid-game".</b> Closing the launcher the moment a match finishes is completely normal
 * behaviour — the player is done — and it drops the socket exactly like a rage-quit does.
 * The only thing telling the two apart is WHEN, so the window has to be wide enough to
 * cover the gap between the last move and the host's report, which can stretch while the
 * host's launcher retries reading the recording.</p>
 *
 * <p>The number is borrowed from ORPHAN_SWEEP_GRACE_MS, which reasons about the same
 * client: the LobbyWebSocket reconnects on its own with backoff up to 30 s, so a blip is
 * not a departure either. 90 s is that plus margin.</p>
 *
 * <p><b>What it does NOT cover, and this is worth knowing before widening the rule:</b> the
 * game is launched re-parented under explorer.exe precisely so it survives the launcher
 * being force-closed, so a player CAN close the launcher and keep playing. That case is
 * scored as an abandonment. It is narrow — it also needs the match to have ended without a
 * readable outcome, since a recording that names a winner always wins — and it is why the
 * launcher warns before letting anyone close it mid-match.</p>
 */
export const RECONNECT_GRACE_SECONDS = 90;

/**
 * How long two players must wait before an abandonment can decide another of their matches.
 *
 * <p>The anti-farm brake with the widest reach. Real disconnections are rare and scattered;
 * farming is the same two accounts, over and over. Nothing else here can tell those apart,
 * because from the outside they are identical.</p>
 */
export const PAIR_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** One `lobby_abandons` row: a socket that dropped mid-match and has not come back. */
export interface AbandonRecord {
    userId: string;
    disconnectedAtMs: number;
}

export interface AbandonInput {
    /** The reported match's participants. */
    participantIds: readonly string[];
    /** Rows still standing for this room — a row is deleted when its owner says hello again. */
    abandons: readonly AbandonRecord[];
    /** `lobbies.started_at`, i.e. when the host pressed Start. Null when unknown. */
    startedAtMs: number | null;
    nowMs: number;
    /**
     * How far into the match a walkout must happen to count, i.e.
     * Config.competitiveAbandonSeconds.
     *
     * <p><b>Measured from the room's start to the moment the socket DROPPED</b> — not to
     * the moment the report arrives. Those are wildly different numbers: the report lands
     * when the HOST closes his game, so measuring against it means a player who left at
     * 4:40 of a match the host kept open for fifteen minutes is judged as though he had
     * played fifteen. He forfeits, and so would he have done leaving at thirty seconds.
     * That was the behaviour, it cost a real player 176 points, and it contradicted the
     * text he agreed to in the create-room dialog.</p>
     */
    abandonAfterSeconds: number;
    /**
     * Whether the report carried a recording fingerprint.
     *
     * <p><b>The brake that makes farming expensive.</b> Without it the recipe is: open a
     * room, wait out the timer, alt-F4, repeat — no game required. Tying the verdict to a
     * real recording puts every such match under the unique index on
     * (game_seed, game_host_time), which already refuses the same game twice.</p>
     */
    reportHasRecording: boolean;
    /** Whether these two already had a match decided this way inside PAIR_COOLDOWN_MS. */
    pairDecidedRecently: boolean;
}

export interface AbandonDecision {
    /** Who forfeited, or null when nothing was decided. */
    loserId: string | null;
    /** Who is credited, or null when nothing was decided. */
    winnerId: string | null;
    /** Always populated, so a refusal can be logged with its cause rather than as a bare null. */
    reason: string;
}

/**
 * Decide a match that the recording could not.
 *
 * <p>The caller must only reach this when ratability said `no_decided_result`: <b>a
 * recording that names a winner always outranks this</b>, because it is evidence and this
 * is an inference.</p>
 */
export function decideByAbandon(input: AbandonInput): AbandonDecision {
    const no = (reason: string): AbandonDecision => ({ loserId: null, winnerId: null, reason });

    // Two players, or "one of them left" says nothing about who won. Same reasoning as
    // ratability's not_1v1, and it has to be repeated here because this function can be
    // reached for a team game once 2v2 exists.
    if (input.participantIds.length !== 2) return no('not a 1v1');

    if (!input.reportHasRecording) return no('the report carried no recording');
    if (input.pairDecidedRecently) return no('these two already had one decided this way today');

    if (input.startedAtMs === null) return no('the room never recorded when it started');
    const startedAtMs = input.startedAtMs;

    // Each walkout is judged on its OWN timestamp against two independent limits, and the
    // two are counted separately so a refusal can say which one applied. `reason` is what
    // the server logs and what `admin.ts match:show` prints, and it is the only account
    // anyone disputing a forfeit will ever get.
    const walkedOut: string[] = [];
    let tooRecent = 0;
    let latestTooEarlySeconds: number | null = null;

    for (const id of input.participantIds) {
        // At most one row per (lobby, user) — that is the table's primary key — and it is
        // deleted the moment its owner says hello again.
        const row = input.abandons.find((a) => a.userId === id);
        if (row === undefined) continue;

        const secondsSinceDrop = (input.nowMs - row.disconnectedAtMs) / 1000;
        const secondsIntoMatch = (row.disconnectedAtMs - startedAtMs) / 1000;
        // A timestamp that will not read decides nothing, the same refusal the room's own
        // start time gets two lines up. This rule already moves rating on an absence of
        // evidence; it must not also move it on a number it could not read.
        if (!Number.isFinite(secondsSinceDrop) || !Number.isFinite(secondsIntoMatch)) continue;

        // Too RECENT to be a departure: the LobbyWebSocket reconnects on its own.
        if (secondsSinceDrop < RECONNECT_GRACE_SECONDS) { tooRecent++; continue; }

        // Too EARLY to be a forfeit: inside the grace the host agreed to in writing. A
        // negative value lands here too, which is the safe direction — it means the clocks
        // disagree about a room that started after somebody left it.
        if (secondsIntoMatch < input.abandonAfterSeconds) {
            latestTooEarlySeconds = Math.max(latestTooEarlySeconds ?? secondsIntoMatch, secondsIntoMatch);
            continue;
        }

        walkedOut.push(id);
    }

    // Nobody left: this match is undecided for some ordinary reason, and inventing a winner
    // is exactly what the rest of the system refuses to do.
    if (walkedOut.length === 0) {
        if (latestTooEarlySeconds !== null) {
            return no(`the latest walkout was ${Math.round(latestTooEarlySeconds)}s into the match, `
                + `inside the first ${input.abandonAfterSeconds}s`);
        }
        if (tooRecent > 0) return no('the dropped socket is still inside the reconnect grace');
        return no('nobody abandoned');
    }

    // BOTH left — the usual cause is the host's connection dying and taking the room with
    // it, which is nobody's forfeit. A draw is the honest answer.
    if (walkedOut.length !== 1) return no('both players abandoned');

    const loserId = walkedOut[0]!;
    const winnerId = input.participantIds.find((id) => id !== loserId)!;
    return { loserId, winnerId, reason: 'one player abandoned and the other stayed' };
}
