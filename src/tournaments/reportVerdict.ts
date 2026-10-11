/**
 * What a stored match report means for its BRACKET slot: advance it, wait, never, or ignore.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * The bracket used to advance on any report whose results were a clean 1/0, read through a
 * loose "every winner is on one roster" test. For a 1v1 that is right. For a TEAM match it
 * was three bugs at once:
 *
 *  1. **It moved on the reporter's word alone.** A team match is deliberately not rated on
 *     one side's reading — it waits `awaiting_confirmation` for a witness from the other side
 *     — yet the bracket advanced the instant the host reported. A host could put his own team
 *     through to the next round with a reading nobody on the other side ever agreed with.
 *  2. **It advanced matches played with the wrong sides.** `teams_mismatch` (the recording's
 *     sides are not the room's) was stored unrated and STILL moved the bracket.
 *  3. **It let a partial line-up decide.** Two players of a 2v2 reporting a 1v1 among
 *     themselves satisfied "every winner is on one roster", so a game half the entrants never
 *     played decided the tie.
 *
 * ---------------------------------------------------------------------------
 * The rules, in order
 * ---------------------------------------------------------------------------
 *  1. A 0.5 anywhere, or a side with nobody on it, is UNDECIDED — "could not be read",
 *     never a draw. The slot stays pending and the room can be opened again.
 *  2. The winners must be EXACTLY one entrant's frozen line-up and the losers exactly the
 *     other's: the right size, nobody missing, nobody from outside.
 *  3. A 1v1 then advances, rated or not — unchanged: a game the ladder refused for
 *     `duplicate_recording` still names a winner, and the owner has a walkover if not.
 *  4. A team match advances only once the OTHER side has corroborated it — the same evidence
 *     that rates it. `teams_mismatch` never advances: the promise the room made was broken,
 *     and the owner decides.
 *
 * Pure. The caller does the I/O (src/tournaments/advance.ts).
 */
import { rosterSizeFor, type TournamentFormat } from './entrants';

/** A win and a loss as the stored `result` encodes them. Mirrors elo/ratability. */
const WIN_AT = 0.999;
const LOSS_AT = 0.001;

export type ReportVerdict =
    | { kind: 'advance'; winnerEntrantId: string; loserEntrantId: string; winners: string[] }
    /** A team result the other side has not corroborated yet. */
    | { kind: 'wait'; reason: 'awaiting_confirmation' }
    /** Played with other sides than the bracket's; only the owner can settle it. */
    | { kind: 'never'; reason: 'teams_mismatch' }
    | { kind: 'ignore'; reason: 'undecided' | 'lineups_do_not_match' };

export interface ReportEntrant {
    id: string;
    /** The FROZEN roster (tournament_entrant_members), never the live team. */
    members: readonly string[];
}

export interface ReportVerdictInput {
    format: TournamentFormat;
    entrant1: ReportEntrant;
    entrant2: ReportEntrant;
    participants: readonly { user_id: string; result: number }[];
    /** `matches.unrated_reason` as stored, null for a rated match. */
    unratedReason: string | null;
    /** Whether a reading from the OTHER side agrees on the same game (teamEvidenceMet). */
    corroborated: boolean;
}

/**
 * Which entrant a set of players IS — exactly its line-up, at the format's size — or null.
 *
 * Exact rather than "a subset of": a subset is how a partial line-up used to decide a slot.
 */
export function entrantOfLineup(
    userIds: readonly string[],
    e1: ReportEntrant,
    e2: ReportEntrant,
    rosterSize: number,
): string | null {
    if (userIds.length !== rosterSize) return null;
    const players = new Set(userIds);
    if (players.size !== userIds.length) return null;
    for (const e of [e1, e2]) {
        const members = new Set(e.members);
        if (members.size !== rosterSize) continue;
        if ([...players].every((u) => members.has(u))) return e.id;
    }
    return null;
}

export function decideReport(i: ReportVerdictInput): ReportVerdict {
    const winners = i.participants.filter((p) => p.result >= WIN_AT).map((p) => p.user_id);
    const losers = i.participants.filter((p) => p.result <= LOSS_AT).map((p) => p.user_id);
    if (winners.length === 0 || losers.length === 0
        || winners.length + losers.length !== i.participants.length) {
        return { kind: 'ignore', reason: 'undecided' };
    }

    const size = rosterSizeFor(i.format);
    const winnerEntrantId = entrantOfLineup(winners, i.entrant1, i.entrant2, size);
    const loserEntrantId = entrantOfLineup(losers, i.entrant1, i.entrant2, size);
    if (!winnerEntrantId || !loserEntrantId || winnerEntrantId === loserEntrantId) {
        return { kind: 'ignore', reason: 'lineups_do_not_match' };
    }

    const advance = { kind: 'advance' as const, winnerEntrantId, loserEntrantId, winners };
    if (i.format === '1v1') return advance;

    switch (i.unratedReason) {
        case 'teams_mismatch':
            return { kind: 'never', reason: 'teams_mismatch' };
        case 'awaiting_confirmation':
            return { kind: 'wait', reason: 'awaiting_confirmation' };
        // Both are only reachable for a team match AFTER the other side corroborated it:
        // `POST /matches` sets `awaiting_confirmation` first, and `new_account_short` is
        // asked only of a result that already stands.
        case null:
        case 'new_account_short':
            return advance;
        // Anything else the ladder refused (a duplicate recording, a mod outside the ranked
        // list, implausible timing…) never went through the team-evidence step, so the
        // bracket asks for that evidence itself.
        default:
            return i.corroborated ? advance : { kind: 'wait', reason: 'awaiting_confirmation' };
    }
}
