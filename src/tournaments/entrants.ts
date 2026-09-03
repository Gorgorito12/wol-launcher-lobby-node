/**
 * Who may enter a tournament, in what order they are seeded, and who moves up when
 * somebody drops out.
 *
 * Pure and side-effect free, like `bracket.ts` and `elo/ratability.ts` — the callers do
 * the I/O and hand in plain data.
 *
 * The rule worth stating up front, because every function here serves it: an ENTRANT is
 * one slot in the bracket, and it holds one player in a 1v1 and a whole team in a 3v3.
 * That is what lets one bracket, one advancement rule and one screen serve both.
 */

/** The shapes a tournament can be played in. A 4v4 is impossible — see `rosterSizeFor`. */
export type TournamentFormat = '1v1' | '2v2' | '3v3';

/** How the rosters behind team entrants come to exist. */
export type TeamSource = 'solo' | 'registered' | 'adhoc' | 'draft';

export type EntrantStatus =
    | 'pending'
    | 'confirmed'
    | 'waitlist'
    | 'rejected'
    | 'withdrawn'
    | 'disqualified';

/**
 * How many players an entrant must field.
 *
 * The ceiling of three is not a product choice. `matchShape` only reads a winner out of
 * 2, 4 or 6 participants, so a 4v4 could be played and could never be reported — offering
 * one would be offering a tournament that cannot finish.
 */
export function rosterSizeFor(format: TournamentFormat): number {
    switch (format) {
        case '1v1': return 1;
        case '2v2': return 2;
        case '3v3': return 3;
    }
}

/** Whether this team-formation mode makes sense for this format. */
export function teamSourceAllowed(format: TournamentFormat, source: TeamSource): boolean {
    return format === '1v1' ? source === 'solo' : source !== 'solo';
}

export type RosterRefusal =
    /** Not the number of players this format needs. */
    | 'wrong_size'
    /** The same person listed twice in one roster. */
    | 'duplicate_member'
    /** Already in another entrant of this same tournament. */
    | 'already_entered'
    /** Banned, or otherwise not allowed to play. */
    | 'member_not_eligible';

export interface RosterInput {
    format: TournamentFormat;
    memberIds: readonly string[];
    /**
     * Everyone already spoken for in this tournament, from
     * `tournament_entrant_members` joined to entrants that still count
     * (`pending`, `confirmed`, `waitlist`). A withdrawn or rejected entrant frees its
     * players, which is what makes re-registering after a mistake possible.
     */
    alreadyEntered: ReadonlySet<string>;
    /** Users the caller has established may not play at all — banned accounts. */
    ineligible?: ReadonlySet<string>;
}

/**
 * Whether this roster may enter, and if not, why.
 *
 * The "already in another entrant" rule is the one that matters and the one a caller
 * would forget: without it the same player can be on two teams in the same bracket, and
 * the moment those two meet there is no honest way to run the match.
 */
export function validateRoster(input: RosterInput): RosterRefusal | null {
    const { format, memberIds, alreadyEntered } = input;
    const ineligible = input.ineligible ?? new Set<string>();

    if (memberIds.length !== rosterSizeFor(format)) return 'wrong_size';

    const seen = new Set<string>();
    for (const id of memberIds) {
        if (!id) return 'wrong_size';
        if (seen.has(id)) return 'duplicate_member';
        seen.add(id);
        if (ineligible.has(id)) return 'member_not_eligible';
        if (alreadyEntered.has(id)) return 'already_entered';
    }
    return null;
}

// ---------------------------------------------------------------- seeding

/**
 * The strength a seeding is sorted by.
 *
 * `rating - 2 * rd` is the CONSERVATIVE Glicko estimate, and it is used here because it
 * is already what orders the public ladder (`stats/rest.ts`). Using the raw rating
 * instead would let somebody with two games and a huge deviation outrank a settled
 * player, and seeding is exactly where that misleads: the top seed gets the bye.
 */
export const DEFAULT_RATING = 1500;
export const DEFAULT_RD = 350;

export interface RatingRow {
    rating: number;
    rd: number;
}

export function conservativeRating(row: RatingRow | undefined): number {
    const rating = row?.rating ?? DEFAULT_RATING;
    const rd = row?.rd ?? DEFAULT_RD;
    return rating - 2 * rd;
}

export interface SeedableEntrant {
    entrantId: string;
    memberIds: readonly string[];
    /** ISO-ish SQLite timestamp; ties break on it so seeding is deterministic. */
    registeredAt: string;
}

/**
 * Order entrants strongest first and number them 1..N.
 *
 * A TEAM is ranked by the MEAN of its members' conservative ratings, not by its captain
 * and not by its best player. A captain-only rule would let a strong player carry two
 * novices to the top seed, and a best-player rule would do the same more quietly.
 *
 * A player with no rating row counts as an unplayed 1500/350, i.e. the bottom of the
 * list rather than the middle — the same answer the ladder gives someone with no games.
 */
export function seedByRating(
    entrants: readonly SeedableEntrant[],
    ratings: ReadonlyMap<string, RatingRow>,
): { entrantId: string; seed: number }[] {
    const scored = entrants.map((e) => ({
        entrantId: e.entrantId,
        registeredAt: e.registeredAt,
        strength: e.memberIds.length === 0
            ? conservativeRating(undefined)
            : e.memberIds.reduce((sum, id) => sum + conservativeRating(ratings.get(id)), 0) / e.memberIds.length,
    }));

    scored.sort((a, b) => {
        if (b.strength !== a.strength) return b.strength - a.strength;
        if (a.registeredAt !== b.registeredAt) return a.registeredAt < b.registeredAt ? -1 : 1;
        // Last resort so the order can never depend on Array.sort stability.
        return a.entrantId < b.entrantId ? -1 : 1;
    });

    return scored.map((e, i) => ({ entrantId: e.entrantId, seed: i + 1 }));
}

export type ExplicitSeedRefusal = 'unknown_entrant' | 'duplicate_entrant' | 'incomplete';

/**
 * Seed from an order the owner typed out, rather than from rating.
 *
 * Insists the list names every entrant exactly once. A partial order would have to be
 * completed by some implicit rule, and an implicit rule in a manual seeding is how you
 * get a bracket nobody can explain.
 */
export function seedByExplicitOrder(
    entrants: readonly SeedableEntrant[],
    order: readonly string[],
): { seeds: { entrantId: string; seed: number }[]; reason?: ExplicitSeedRefusal } {
    const known = new Set(entrants.map((e) => e.entrantId));
    const seen = new Set<string>();

    for (const id of order) {
        if (!known.has(id)) return { seeds: [], reason: 'unknown_entrant' };
        if (seen.has(id)) return { seeds: [], reason: 'duplicate_entrant' };
        seen.add(id);
    }
    if (seen.size !== known.size) return { seeds: [], reason: 'incomplete' };

    return { seeds: order.map((entrantId, i) => ({ entrantId, seed: i + 1 })) };
}

// ---------------------------------------------------------------- capacity

export interface WaitlistCandidate {
    entrantId: string;
    status: EntrantStatus;
    registeredAt: string;
}

/**
 * Who moves up when a slot frees, in order.
 *
 * First come, first served on `registered_at`, because that is the only order anybody
 * waiting can predict. Returns as many as there are free slots, so one call covers both
 * a single withdrawal and the owner raising the capacity.
 *
 * Deliberately does NOT decide whether the slot is really free: the caller claims the
 * seat with a conditional UPDATE and finds that out for certain. Two writers promoting
 * the same person is a race this function cannot see and must not pretend to prevent.
 */
export function promoteFromWaitlist(
    candidates: readonly WaitlistCandidate[],
    freeSlots: number,
): string[] {
    if (freeSlots <= 0) return [];
    return candidates
        .filter((c) => c.status === 'waitlist')
        .slice()
        .sort((a, b) => (a.registeredAt === b.registeredAt
            ? (a.entrantId < b.entrantId ? -1 : 1)
            : (a.registeredAt < b.registeredAt ? -1 : 1)))
        .slice(0, freeSlots)
        .map((c) => c.entrantId);
}

/**
 * The status a new registration lands in.
 *
 * `approval` mode ignores capacity entirely at this point: everybody becomes `pending`,
 * and the seat is only claimed when the owner accepts. Checking capacity twice — once
 * here and once on acceptance — would let a tournament fill up with applications it can
 * never take, which reads to the applicant as a bug.
 */
export function entryStatusFor(
    entryMode: 'open' | 'approval',
    seatClaimed: boolean,
): Extract<EntrantStatus, 'pending' | 'confirmed' | 'waitlist'> {
    if (entryMode === 'approval') return 'pending';
    return seatClaimed ? 'confirmed' : 'waitlist';
}

/** The statuses that hold a place in the tournament and therefore block re-entering. */
export function occupiesTournament(status: EntrantStatus): boolean {
    return status === 'pending' || status === 'confirmed' || status === 'waitlist';
}

/** The statuses that get a bracket slot when the owner starts the tournament. */
export function playsInBracket(status: EntrantStatus): boolean {
    return status === 'confirmed';
}
