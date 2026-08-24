/**
 * Whether a reported match may move anyone's rating — and, when it may not, why.
 *
 * This lives apart from the Glicko maths on purpose. It is the ONE place that
 * decides what scores, and the server is the only place it may live: the launcher
 * used to hold half of this policy, which is exactly how it came to tell a player
 * "it counted towards no one's rating" while the backend was busy counting it. The
 * reason travels back to the client so the client can *report* the decision without
 * ever having to *make* it.
 *
 * Pure and side-effect free — the callers do the I/O and hand in plain data.
 */

/** Why a match was stored but not scored. Null means it was scored. */
export type UnratedReason =
    /** The mod has no ladder. See Config.rankedModIds. */
    | 'mod_not_ranked'
    /** Not exactly two players. A recording names one loser, which says nothing
     *  about the other three in a team game. */
    | 'not_1v1'
    /** Nobody won: no recording, or one that could not be read. */
    | 'no_decided_result'
    /** Reported without a room, so there is nothing to check the players against. */
    | 'no_lobby'
    /** Someone in the report never joined the room they are said to have played in. */
    | 'participants_not_in_lobby'
    /** The clock does not add up: too short, or the timestamps disagree with it. */
    | 'implausible_timing'
    /** This exact recording already scored a match. */
    | 'duplicate_recording';

/**
 * A win and a loss, as the stored `result` encodes them.
 *
 * Compared by threshold rather than equality, and the values match the tally in
 * `GET /matches/elo/:userId` and the launcher's `MatchOutcomeView.Classify`. Three
 * copies of one rule is two too many, but they are at least the same numbers —
 * change one and change all three.
 */
export const WIN_AT = 0.999;
export const LOSS_AT = 0.001;

export function isDecided(result: number): boolean {
    return result >= WIN_AT || result <= LOSS_AT;
}

/** Whether two independent readings of the same match tell the same story. */
export type ReadingAgreement = 'agree' | 'disagree' | 'inconclusive';

/**
 * Compare the host's reported score for a player with that player's own reading.
 *
 * <p>Both come from the trailer of a recording, and the trailer names the winner and
 * loser by ABSOLUTE slot — so two honest recordings of one match cannot disagree.
 * Which is exactly why a disagreement is worth writing down.</p>
 *
 * <p><b>`inconclusive` when EITHER side is 0.5</b>, and that distinction is the point
 * of collecting this at all. "Nobody could read it" is not "the two of them contradict
 * each other", and folding the first into `disagree` would make the evidence measure
 * the wrong thing — it would look like rampant conflict when what really happened is
 * that somebody's game was not recorded.</p>
 */
export function compareReadings(reported: number, confirmed: number): ReadingAgreement {
    if (!isDecided(reported) || !isDecided(confirmed)) return 'inconclusive';
    // Both decided: they either name the same outcome for this player, or they don't.
    const reportedWon = reported >= WIN_AT;
    const confirmedWon = confirmed >= WIN_AT;
    return reportedWon === confirmedWon ? 'agree' : 'disagree';
}

/**
 * Rating deviation above which Glicko is still finding a player's level.
 *
 * Mirrors MatchOutcomeView.ProvisionalRd in the launcher, which uses it to decide
 * whether a rating may be shown at all — a number the server handed out for free
 * must never be painted as if it had been earned. The leaderboard applies the same
 * line: a ladder that mixes settled ratings with three-game ones is sorting noise.
 * The launcher compares with a strict >, so exactly 110 counts as settled on both
 * sides.
 */
export const PROVISIONAL_RD = 110;

/**
 * A match shorter than this was not a match. The launcher already refuses to
 * report one (an AoE3 opened and closed), but the launcher is precisely what an
 * attacker controls, so the number has to exist on this side too.
 */
export const MIN_DURATION_SECONDS = 180;

/** How far the reported duration may drift from ended_at - started_at. Generous:
 *  the two are measured by different clocks on the same machine, one of them a
 *  stopwatch around the game process. */
export const DURATION_SLACK_SECONDS = 120;

/** Clock skew allowed on started_at, and how far back a report may reach. */
export const FUTURE_SKEW_MS = 5 * 60 * 1000;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface RatabilityInput {
    modId: string;
    rankedModIds: readonly string[];
    participants: readonly { result: number }[];
    /** Whether the report named a room at all. */
    hasLobby: boolean;
    /** Whether every reported player is a member of that room. The caller does
     *  the lookup; this stays pure. Ignored when hasLobby is false. */
    allParticipantsInLobby: boolean;
    startedAt: string;
    endedAt: string;
    durationSeconds: number;
    /** Injected so the timing rules can be tested without waiting for a clock. */
    nowMs: number;
}

/**
 * The clock half, split out because it is the only part with arithmetic worth
 * reading on its own. Returns true when the times could describe a real game.
 */
export function timingIsPlausible(input: RatabilityInput): boolean {
    const started = Date.parse(input.startedAt);
    const ended = Date.parse(input.endedAt);
    if (!Number.isFinite(started) || !Number.isFinite(ended)) return false;
    if (ended <= started) return false;

    if (started > input.nowMs + FUTURE_SKEW_MS) return false;
    if (input.nowMs - started > MAX_AGE_MS) return false;

    const duration = input.durationSeconds;
    if (!Number.isFinite(duration) || duration < MIN_DURATION_SECONDS) return false;

    const spanSeconds = (ended - started) / 1000;
    if (spanSeconds < MIN_DURATION_SECONDS) return false;
    if (Math.abs(spanSeconds - duration) > DURATION_SLACK_SECONDS) return false;

    return true;
}

/**
 * The order of the checks is the order of the answers: the least specific cause
 * wins, so a team game on an unranked mod reports the mod, which is the thing the
 * player would have to change first.
 */
export function ratabilityReason(input: RatabilityInput): UnratedReason | null {
    const mod = (input.modId || '').trim().toLowerCase();
    if (!input.rankedModIds.some((m) => m === mod)) return 'mod_not_ranked';

    // Exactly two, not "at least one decided result". The launcher can only ever
    // resolve a winner for a 1v1 (MatchResultResolver refuses anything else), so a
    // three-player match claiming a decided result did not come from a launcher we
    // wrote — and this is the cheapest place to say no to it.
    if (input.participants.length !== 2) return 'not_1v1';

    // Without a room there is no roster to check the names against, and the
    // fallback branch of POST /matches only asks that the reporter be one of the
    // players they themselves listed — which is not a check. Still stored, never
    // scored.
    if (!input.hasLobby) return 'no_lobby';
    if (!input.allParticipantsInLobby) return 'participants_not_in_lobby';

    if (!timingIsPlausible(input)) return 'implausible_timing';

    if (!input.participants.some((p) => isDecided(p.result))) return 'no_decided_result';

    return null;
}
