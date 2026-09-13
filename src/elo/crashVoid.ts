/**
 * Whether a verified crash VOIDS a rated 1v1 — and, when it does not, why.
 *
 * <p><b>What this exists for.</b> Wars of Liberty runs on a 2007 engine that crashes, and
 * a crash used to be a loss by evidence: the opponent's recording names the crashed player
 * the loser, and nothing could tell the crash from a dodge. The maintainer's call was that
 * the ladder must handle it on its own — no operator review, no opponent's consent — so
 * the launcher VERIFIES the crash against Windows (crashEvidence.ts) and this decides.</p>
 *
 * <p><b>It only ever VOIDS. It never flips a result.</b> The crashed player does not win;
 * the match stops counting, for both. That is the whole of what a claimed crash can buy,
 * and it is bounded further by a budget: at most `perWindow` voids per player per window,
 * after which the standard bargain applies and the crash is the loss it always was. A
 * tournament match is never voided — a bracket cannot be undone without somebody deciding
 * a rematch, and "nobody decides by hand" is the requirement.</p>
 *
 * <p>Pure and side-effect free.</p>
 */

export interface CrashVoidInput {
    participantIds: readonly string[];
    /** The decided loser, or null when nobody lost. */
    loserId: string | null;
    /** Players whose game exit the server verified as a crash, for this room. */
    crashedIds: ReadonlySet<string>;
    /** How many matches the loser has already had voided this way inside the window. */
    priorVoidsForLoser: number;
    /** Config.crashVoidPerWindow. */
    perWindow: number;
    isTournament: boolean;
}

export interface CrashVoidDecision {
    /** Whose crash voided the match, or null when it still counts. */
    voidFor: string | null;
    /** Always populated, so a refusal can be logged with its cause rather than as a bare null. */
    reason: string;
}

export function decideCrashVoid(input: CrashVoidInput): CrashVoidDecision {
    const no = (reason: string): CrashVoidDecision => ({ voidFor: null, reason });

    if (input.participantIds.length !== 2) return no('not a 1v1');
    if (input.loserId === null) return no('nobody lost');
    if (!input.participantIds.includes(input.loserId)) return no('the loser is not a participant');

    // The WINNER crashing changes nothing: he won before it, or the other side's recording
    // would not name him the winner. Only the loser's crash can be what ended the match.
    if (!input.crashedIds.has(input.loserId)) return no('the loser did not crash');

    if (input.isTournament) return no('a tournament match is never voided');

    if (input.priorVoidsForLoser >= input.perWindow) {
        return no(`the loser already had ${input.priorVoidsForLoser} match(es) voided this way `
            + `inside the window; this one counts`);
    }

    return { voidFor: input.loserId, reason: 'the loser\'s game crashed, verified' };
}
