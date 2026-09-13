/**
 * Whether a competitive match that NOBODY reported can be founded from the readings the
 * players sent on their own — and, when it cannot, why.
 *
 * <p><b>What this exists for.</b> Only the host reports (`POST /matches`), and a host who
 * closes everything mid-match never does. Until this existed the match then simply did not
 * exist: the opponent's confirmation sat in `match_confirmations` with `match_id NULL` for
 * ever, carrying a decided reading and a recording fingerprint the server never looked at.
 * The dodge was free, and so was the loss of every honest match whose host's launcher died.</p>
 *
 * <p><b>The rule is the mirror of `canUpgradeFromConfirmation`, with one more witness.</b>
 * A reading that concedes its OWN defeat founds the match at once — nobody lies to lose. A
 * reading that claims its own VICTORY founds it only when the server itself saw the opponent
 * walk out: a `lobby_abandons` row past both of the abandonment rule's thresholds. "I won" and
 * "he left" is one coherent story told by two witnesses; either alone founds nothing, so an
 * invented victory still has no reason to be invented.</p>
 *
 * <p><b>Everything founded here is an INFERENCE and is marked as one</b> (`decided_by =
 * 'founded'`), which is what lets a later reading that contradicts it UNDO it — the class
 * `'abandon'` already belongs to. A match decided by a recording never is.</p>
 *
 * <p>Pure and side-effect free: the caller does the I/O and hands in plain data.</p>
 */
import { RECONNECT_GRACE_SECONDS, pickRecord, type AbandonRecord } from './abandon';
import { isDecided, LOSS_AT, WIN_AT } from './ratability';

/** One player's own reading of the match, as `match_confirmations` stores it. */
export interface FoundingReading {
    userId: string;
    /** Their score for THEMSELVES: 0 lost, 1 won, 0.5 could not tell. */
    result: number;
    /** Whether the reading carries the recording's `game_seed` + `game_host_time`. */
    hasFingerprint: boolean;
}

export interface FoundingInput {
    /** The roster frozen at Start. */
    participantIds: readonly string[];
    /** Every reading stored for this room. */
    readings: readonly FoundingReading[];
    /** Every walkout still standing for this room, from both sources — see `AbandonRecord`. */
    walkouts: readonly AbandonRecord[];
    /** `lobbies.started_at`. Null when unknown. */
    startedAtMs: number | null;
    nowMs: number;
    /**
     * When this server LEARNED to found matches — a room that started before it is never
     * founded, however good its readings look.
     *
     * <p><b>The gap this closes, and it was not hypothetical.</b> Orphaned confirmations
     * accumulate for as long as hosts have been failing to report — weeks of them — and
     * `foundPendingForUser` hangs off `GET /matches/history`, which is what the launcher calls
     * when somebody opens the History tab. Without this, the day this deployed, the first
     * person to open that tab would have had up to ten of their old rooms founded and rated in
     * one go, passively, having asked for nothing. Nor would luck have saved them: the old
     * rooms still eligible are precisely the ones whose host vanished, because the old code
     * only cleared `started_at` when the host closed properly.</p>
     *
     * <p>The caller reads it from `_migrations.applied_at` of the migration that shipped
     * founding — automatic, exact, and impossible to set wrong, unlike a configured date.</p>
     */
    foundingEnabledFromMs: number;
    /**
     * How late a match may still be founded. Hygiene rather than safety: the epoch above
     * already answers "never anything from before this existed", and this answers "never
     * anything that has been sitting around for weeks". Reuses the server's own
     * `MAX_AGE_MS` — if the host is not allowed to REPORT a match this old, the server has no
     * business inventing one.
     */
    maxAgeMs: number;
    /** Config.competitiveAbandonSeconds — the same threshold the abandonment rule uses. */
    abandonAfterSeconds: number;
    /** A `matches` row already exists for this room. There is nothing to found. */
    hasReport: boolean;
    /** Whether these two already had a match INFERRED inside PAIR_COOLDOWN_MS. */
    pairDecidedRecently: boolean;
    /** Whether a founding reading's fingerprint already decided some other match. */
    fingerprintAlreadyUsed: boolean;
    /**
     * The room is closed. Nobody can say hello to a closed room, so the reconnect grace the
     * socket rule waits out has nothing left to wait for and is skipped. While the room is
     * still open a dropped socket may yet come back and delete its own row.
     */
    roomClosed: boolean;
}

export interface FoundingDecision {
    /** Whose reading founded the match, or null when nothing was founded. */
    founderId: string | null;
    winnerId: string | null;
    loserId: string | null;
    /** Always populated, so a refusal can be logged with its cause rather than as a bare null. */
    reason: string;
}

/**
 * Decide whether the readings on file can found the match nobody reported.
 *
 * <p>The caller must only reach this when NO report exists: a report, even an undecided
 * one, is the host's account and takes the ordinary path.</p>
 */
export function decideFounding(input: FoundingInput): FoundingDecision {
    const no = (reason: string): FoundingDecision =>
        ({ founderId: null, winnerId: null, loserId: null, reason });

    if (input.hasReport) return no('a report exists; nothing to found');

    // Two players, or one reading says nothing about who won. Same refusal as
    // decideByAbandon, for the same reason.
    if (input.participantIds.length !== 2) return no('not a 1v1');

    if (input.pairDecidedRecently) return no('these two already had one inferred today');
    if (input.startedAtMs === null) return no('the room never recorded when it started');
    const startedAtMs = input.startedAtMs;

    // From here forward, and only from here forward. See foundingEnabledFromMs: the History
    // hook goes looking for orphaned readings, so without this the backlog of every room a
    // host ever failed to report would be founded in bulk the day this deployed.
    if (startedAtMs < input.foundingEnabledFromMs) {
        return no('the room started before founding existed on this server');
    }

    const ageMs = input.nowMs - startedAtMs;
    if (Number.isFinite(ageMs) && ageMs > input.maxAgeMs) {
        return no(`the match is ${Math.round(ageMs / 86_400_000)} day(s) old, past the limit`);
    }

    // Only a reading from somebody who played, that names a winner, and that carries the
    // recording's fingerprint — the same bar every other verdict in the project sets.
    const usable = input.readings.filter((r) =>
        input.participantIds.includes(r.userId) && isDecided(r.result) && r.hasFingerprint);
    if (usable.length === 0) return no('no decided, fingerprinted reading on file');

    // Both players read their recordings and they contradict each other: two victories, or
    // two defeats. Nothing is founded on a disagreement — and note that "both won" is the
    // shape a pair of colluders would have to produce to game this, so it is the refusal
    // that matters.
    if (usable.length === 2) {
        const [a, b] = usable as [FoundingReading, FoundingReading];
        const aWon = a.result >= WIN_AT;
        const bWon = b.result >= WIN_AT;
        if (aWon === bWon) return no('the two readings contradict each other');
    }

    if (input.fingerprintAlreadyUsed) return no('that recording already decided another match');

    // A conceded defeat founds at once. Nobody lies to lose, so this is the reading that
    // needs no witness — the same rule `canUpgradeFromConfirmation` applies to a late reading.
    const conceded = usable.find((r) => r.result <= LOSS_AT);
    if (conceded) {
        const winnerId = input.participantIds.find((id) => id !== conceded.userId)!;
        return {
            founderId: conceded.userId, winnerId, loserId: conceded.userId,
            reason: 'own defeat conceded',
        };
    }

    // What is left is a single claimed VICTORY, and it needs the second witness: the server
    // saw the opponent walk out, past the same two thresholds the abandonment rule applies.
    const claim = usable[0]!;
    const opponentId = input.participantIds.find((id) => id !== claim.userId)!;

    const row = pickRecord(input.walkouts, opponentId);
    if (row === undefined) return no('a claimed victory needs the opponent to have walked out, and he did not');
    // A closed GAME is not a walkout — the rule the abandonment verdict already lives by. In
    // a 1v1 both games end together, so the opponent's game closing corroborates nothing
    // about who won; only his connection dying and staying dead does.
    if (row.source === 'game') return no('the opponent closed his game, which is not a walkout');

    const secondsIntoMatch = (row.disconnectedAtMs - startedAtMs) / 1000;
    if (!Number.isFinite(secondsIntoMatch)) return no('the walkout carries no readable time');

    if (!input.roomClosed) {
        const secondsSinceDrop = (input.nowMs - row.disconnectedAtMs) / 1000;
        if (!Number.isFinite(secondsSinceDrop)) return no('the walkout carries no readable time');
        if (secondsSinceDrop < RECONNECT_GRACE_SECONDS) {
            return no('the opponent dropped inside the reconnect grace and may still come back');
        }
    }

    if (secondsIntoMatch < input.abandonAfterSeconds) {
        return no(`the opponent walked out ${Math.round(secondsIntoMatch)}s into the match, `
            + `inside the first ${input.abandonAfterSeconds}s`);
    }

    return {
        founderId: claim.userId, winnerId: claim.userId, loserId: opponentId,
        reason: 'own victory, corroborated by the opponent walking out',
    };
}
