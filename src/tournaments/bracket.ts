/**
 * The single-elimination bracket: how it is built, how a result moves through it, and
 * what may be undone.
 *
 * Pure and side-effect free, like `elo/ratability.ts` — the callers do the I/O and hand
 * in plain data. That matters more here than usual: the advancement hook runs inside the
 * match-report path, where the cost of a bug is a tournament that silently stops
 * progressing, and the only cheap way to be sure of the rules is to be able to run them
 * against a table of cases with no database in the way.
 *
 * Everything below is expressed in ENTRANT ids, never user ids. An entrant is one player
 * in a 1v1 and a whole team in a 3v3, which is what lets one bracket serve both.
 */

/** Where a bracket match stands. A `bye` was never played and can never be undone. */
export type BracketStatus = 'pending' | 'done' | 'bye';

/**
 * How a decided match came to be decided.
 *
 * `played` is the only one with a game behind it. The other three exist so that a
 * finished bracket can still say "nobody actually played this", which is the question
 * anybody disputing a tournament asks first.
 */
export type BracketOutcome = 'played' | 'walkover' | 'dq' | 'bye';

/** A slot in the next round. 1 is `entrant1_id`, 2 is `entrant2_id`. */
export type Slot = 1 | 2;

export interface BracketMatch {
    id: string;
    /** 1 = first round. The final is `roundsFor(n)`. */
    round: number;
    /** 0-based within the round. */
    position: number;
    entrant1Id: string | null;
    entrant2Id: string | null;
    winnerEntrantId: string | null;
    status: BracketStatus;
    outcome: BracketOutcome | null;
    /** Null on the final, and only on the final. */
    nextMatchId: string | null;
    nextSlot: Slot | null;
}

/**
 * A structural change to one match, keyed by id.
 *
 * Deliberately carries only what the BRACKET decides. `decided_by`, `decided_at` and
 * `match_id` are the caller's to add: they are facts about who reported and when, not
 * about the shape of the tree, and keeping them out is what stops this module needing to
 * know what a user id or a clock is.
 */
export interface BracketUpdate {
    id: string;
    entrant1Id?: string | null;
    entrant2Id?: string | null;
    winnerEntrantId?: string | null;
    status?: BracketStatus;
    outcome?: BracketOutcome | null;
}

export type AdvanceRefusal =
    /** No match with that id in this bracket. */
    | 'match_not_found'
    /** Already `done` — the claim in the caller should have caught this first. */
    | 'already_decided'
    /** A bye is not a match anybody can win or undo. */
    | 'is_bye'
    /** The named winner does not occupy either slot of this match. */
    | 'winner_not_in_match';

export interface AdvanceResult {
    ok: boolean;
    reason?: AdvanceRefusal;
    updates: BracketUpdate[];
    /** True when the final is now decided. */
    tournamentDone: boolean;
    championEntrantId: string | null;
    /** Matches that have BOTH entrants as a result of this call, so somebody can play them. */
    newlyReady: string[];
}

export type VoidRefusal =
    | 'match_not_found'
    | 'is_bye'
    /** Nothing to undo. */
    | 'not_decided'
    /** The next round is already resolved; undoing this would orphan that result. */
    | 'next_round_decided';

export interface VoidResult {
    ok: boolean;
    reason?: VoidRefusal;
    updates: BracketUpdate[];
}

// ---------------------------------------------------------------- shape

/**
 * The smallest power of two that seats everyone.
 *
 * A tournament of one is not a tournament, and `Math.log2` of zero is not a round count,
 * so two is the floor rather than a special case handled downstream.
 */
export function bracketSize(entrantCount: number): number {
    if (!Number.isFinite(entrantCount) || entrantCount < 2) return 2;
    let size = 2;
    while (size < entrantCount) size *= 2;
    return size;
}

/** How many rounds a bracket of this many entrants has. 2 entrants is 1 round. */
export function roundsFor(entrantCount: number): number {
    return Math.log2(bracketSize(entrantCount));
}

/** How many matches the given round holds. */
export function matchesInRound(size: number, round: number): number {
    return size / 2 ** round;
}

/**
 * The standard single-elimination seed placement, read two at a time.
 *
 * `seedOrder(8)` is `[1,8,4,5,2,7,3,6]`, which is first-round match 0 = seed 1 v seed 8,
 * match 1 = 4 v 5, and so on. Built by repeated mirroring: every doubling pairs each seed
 * already placed with `n + 1 - s`.
 *
 * Two properties fall out of that construction and both are load-bearing, so both are
 * pinned by tests rather than left as folklore:
 *
 *  - **Every first-round pair sums to `size + 1`.** One of each pair is therefore in the
 *    top half of the seeding. Because `size` is the SMALLEST power of two that seats
 *    everyone, more than half the seats are filled, so every first-round match has at
 *    least one real entrant — which is why a double bye cannot occur and is not handled.
 *  - **The top two seeds cannot meet before the final**, the whole point of seeding.
 */
export function seedOrder(size: number): number[] {
    let order = [1];
    while (order.length < size) {
        const n = order.length * 2;
        const next: number[] = [];
        for (const s of order) {
            next.push(s);
            next.push(n + 1 - s);
        }
        order = next;
    }
    return order;
}

/** Where the winner of `(round, position)` goes. Null on the final. */
export function nextOf(
    round: number,
    position: number,
    roundsTotal: number,
): { round: number; position: number; slot: Slot } | null {
    if (round >= roundsTotal) return null;
    return {
        round: round + 1,
        position: position >> 1,
        slot: ((position & 1) + 1) as Slot,
    };
}

/** Whether somebody could sit down and play this right now. */
export function playable(m: BracketMatch): boolean {
    return m.status === 'pending' && m.entrant1Id !== null && m.entrant2Id !== null;
}

export interface SeededEntrant {
    entrantId: string;
    /** 1-based, contiguous, no duplicates. */
    seed: number;
}

/**
 * Build every match of the bracket, with byes already decided and propagated.
 *
 * Byes are resolved HERE rather than by a later pass, so that the moment a tournament
 * starts, the rows in the database are already the truth: a first-round match with one
 * entrant is stored `done`/`bye` and the second round already knows who is waiting in it.
 * Anything else would leave a tournament whose bracket is only correct once something
 * else has run.
 *
 * Throws on malformed seeding — duplicate or non-contiguous seeds are a bug in the
 * seeding step, not a condition a caller should be handling at runtime.
 */
export function generateBracket(
    entrants: readonly SeededEntrant[],
    mintId: () => string,
): BracketMatch[] {
    if (entrants.length < 2) throw new Error('a bracket needs at least two entrants');

    const bySeed = new Map<number, string>();
    for (const e of entrants) {
        if (bySeed.has(e.seed)) throw new Error(`duplicate seed ${e.seed}`);
        bySeed.set(e.seed, e.entrantId);
    }
    for (let s = 1; s <= entrants.length; s++) {
        if (!bySeed.has(s)) throw new Error(`seed ${s} is missing; seeds must be 1..N`);
    }

    const size = bracketSize(entrants.length);
    const rounds = Math.log2(size);

    // Every match first, so the links can be written in one pass afterwards.
    const grid: BracketMatch[][] = [];
    for (let r = 1; r <= rounds; r++) {
        const row: BracketMatch[] = [];
        for (let p = 0; p < matchesInRound(size, r); p++) {
            row.push({
                id: mintId(),
                round: r,
                position: p,
                entrant1Id: null,
                entrant2Id: null,
                winnerEntrantId: null,
                status: 'pending',
                outcome: null,
                nextMatchId: null,
                nextSlot: null,
            });
        }
        grid.push(row);
    }

    for (let r = 1; r < rounds; r++) {
        for (const m of grid[r - 1]) {
            const nxt = nextOf(m.round, m.position, rounds)!;
            m.nextMatchId = grid[nxt.round - 1][nxt.position].id;
            m.nextSlot = nxt.slot;
        }
    }

    // Seat the first round, then let the byes fall through.
    const order = seedOrder(size);
    for (let p = 0; p < grid[0].length; p++) {
        const m = grid[0][p];
        m.entrant1Id = bySeed.get(order[p * 2]) ?? null;
        m.entrant2Id = bySeed.get(order[p * 2 + 1]) ?? null;
    }

    const byId = new Map(grid.flat().map((m) => [m.id, m]));
    for (const m of grid[0]) {
        const present = [m.entrant1Id, m.entrant2Id].filter((x): x is string => x !== null);
        // Cannot be 0: see the `size + 1` property on seedOrder.
        if (present.length !== 1) continue;
        m.status = 'bye';
        m.outcome = 'bye';
        m.winnerEntrantId = present[0];
        seat(byId, m, present[0]);
    }

    return grid.flat();
}

/** Write a winner into the slot it feeds. No-op on the final. */
function seat(byId: Map<string, BracketMatch>, from: BracketMatch, entrantId: string): void {
    if (!from.nextMatchId || !from.nextSlot) return;
    const next = byId.get(from.nextMatchId);
    if (!next) return;
    if (from.nextSlot === 1) next.entrant1Id = entrantId;
    else next.entrant2Id = entrantId;
}

// ---------------------------------------------------------------- movement

/**
 * Record a winner and move them into the next round.
 *
 * `disqualified` is consulted AFTER a slot is filled, not before: a player can be thrown
 * out while their next opponent is still unknown, and the walkover only becomes
 * expressible once somebody arrives to receive it. Resolving that lazily here is what
 * keeps `disqualify` from having to guess at the future.
 */
export function advance(
    matches: readonly BracketMatch[],
    matchId: string,
    winnerEntrantId: string,
    outcome: Exclude<BracketOutcome, 'bye'>,
    disqualified: ReadonlySet<string> = new Set(),
): AdvanceResult {
    const work = clone(matches);
    const byId = new Map(work.map((m) => [m.id, m]));
    const target = byId.get(matchId);

    if (!target) return refuse('match_not_found');
    if (target.status === 'bye') return refuse('is_bye');
    if (target.status === 'done') return refuse('already_decided');
    if (winnerEntrantId !== target.entrant1Id && winnerEntrantId !== target.entrant2Id) {
        return refuse('winner_not_in_match');
    }

    const touched = new Set<string>();
    const newlyReady: string[] = [];
    settle(byId, target, winnerEntrantId, outcome, disqualified, touched, newlyReady);

    const final = work.find((m) => m.nextMatchId === null)!;
    return {
        ok: true,
        updates: [...touched].map((id) => toUpdate(byId.get(id)!)),
        tournamentDone: final.status === 'done' || final.status === 'bye',
        championEntrantId: final.winnerEntrantId,
        newlyReady,
    };
}

/**
 * Decide one match and follow the consequences as far as they go.
 *
 * Recursive because a disqualification can cascade: the winner arrives in the next round,
 * finds a disqualified opponent already sitting there, and wins that one too — possibly
 * all the way to the final.
 */
function settle(
    byId: Map<string, BracketMatch>,
    m: BracketMatch,
    winnerEntrantId: string,
    outcome: Exclude<BracketOutcome, 'bye'>,
    disqualified: ReadonlySet<string>,
    touched: Set<string>,
    newlyReady: string[],
): void {
    m.status = 'done';
    m.outcome = outcome;
    m.winnerEntrantId = winnerEntrantId;
    touched.add(m.id);

    if (!m.nextMatchId || !m.nextSlot) return;
    const next = byId.get(m.nextMatchId);
    if (!next) return;

    if (m.nextSlot === 1) next.entrant1Id = winnerEntrantId;
    else next.entrant2Id = winnerEntrantId;
    touched.add(next.id);

    if (next.entrant1Id === null || next.entrant2Id === null) return;
    if (next.status !== 'pending') return;

    const oneOut = disqualified.has(next.entrant1Id);
    const twoOut = disqualified.has(next.entrant2Id);
    // Both gone is not a walkover for anybody; it needs a human, so leave it standing.
    if (oneOut !== twoOut) {
        const survivor = oneOut ? next.entrant2Id : next.entrant1Id;
        settle(byId, next, survivor, 'dq', disqualified, touched, newlyReady);
        return;
    }
    newlyReady.push(next.id);
}

/**
 * Throw an entrant out, and hand every match they were still in to whoever was waiting.
 *
 * A pending match whose OTHER slot is still empty is deliberately left alone: there is
 * nobody to award it to yet. `advance` picks it up when the opponent arrives.
 */
export function disqualify(
    matches: readonly BracketMatch[],
    entrantId: string,
): BracketUpdate[] {
    const work = clone(matches);
    const byId = new Map(work.map((m) => [m.id, m]));
    const touched = new Set<string>();
    const newlyReady: string[] = [];
    const out = new Set([entrantId]);

    for (const m of work) {
        if (m.status !== 'pending') continue;
        if (m.entrant1Id !== entrantId && m.entrant2Id !== entrantId) continue;
        const other = m.entrant1Id === entrantId ? m.entrant2Id : m.entrant1Id;
        if (other === null) continue;
        if (out.has(other)) continue;
        settle(byId, m, other, 'dq', out, touched, newlyReady);
    }

    return [...touched].map((id) => toUpdate(byId.get(id)!));
}

/**
 * Undo a decided match, and empty the slot it filled.
 *
 * Refuses when the next round has already been decided, because clearing this result
 * would leave that one standing on an entrant who is no longer known to have got there.
 * `cascade` is the deliberate override, and it undoes forwards first so the bracket is
 * never momentarily inconsistent.
 *
 * Voiding here says nothing about the LADDER: the game that was played still rated, and
 * un-rating it is a separate decision made with `match:void`. Two different questions,
 * two different commands, on purpose.
 */
export function voidMatch(
    matches: readonly BracketMatch[],
    matchId: string,
    cascade = false,
): VoidResult {
    const work = clone(matches);
    const byId = new Map(work.map((m) => [m.id, m]));
    const target = byId.get(matchId);

    if (!target) return { ok: false, reason: 'match_not_found', updates: [] };
    if (target.status === 'bye') return { ok: false, reason: 'is_bye', updates: [] };
    if (target.status !== 'done') return { ok: false, reason: 'not_decided', updates: [] };

    const touched = new Set<string>();
    const refusal = unwind(byId, target, cascade, touched);
    if (refusal) return { ok: false, reason: refusal, updates: [] };

    return { ok: true, updates: [...touched].map((id) => toUpdate(byId.get(id)!)) };
}

function unwind(
    byId: Map<string, BracketMatch>,
    m: BracketMatch,
    cascade: boolean,
    touched: Set<string>,
): VoidRefusal | null {
    const next = m.nextMatchId ? byId.get(m.nextMatchId) ?? null : null;

    if (next && next.status === 'done') {
        if (!cascade) return 'next_round_decided';
        const refusal = unwind(byId, next, true, touched);
        if (refusal) return refusal;
    }

    if (next && m.nextSlot) {
        if (m.nextSlot === 1) next.entrant1Id = null;
        else next.entrant2Id = null;
        touched.add(next.id);
    }

    m.status = 'pending';
    m.outcome = null;
    m.winnerEntrantId = null;
    touched.add(m.id);
    return null;
}

// ---------------------------------------------------------------- plumbing

function clone(matches: readonly BracketMatch[]): BracketMatch[] {
    return matches.map((m) => ({ ...m }));
}

function toUpdate(m: BracketMatch): BracketUpdate {
    return {
        id: m.id,
        entrant1Id: m.entrant1Id,
        entrant2Id: m.entrant2Id,
        winnerEntrantId: m.winnerEntrantId,
        status: m.status,
        outcome: m.outcome,
    };
}

function refuse(reason: AdvanceRefusal): AdvanceResult {
    return { ok: false, reason, updates: [], tournamentDone: false, championEntrantId: null, newlyReady: [] };
}
