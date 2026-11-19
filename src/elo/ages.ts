/**
 * The rank badges' ages, cut by SHARE of the ladder. A port of the launcher's
 * `RankAges.Bounds` (Services/Multiplayer/RankAges.cs), so the server can say how far a player
 * is from the next badge without the two ever disagreeing about where an age starts.
 *
 * <p><b>The same literal table (sizes 1-20, 25, 30, 40, 50, 60) is pinned in both test suites</b>
 * (`ages.test.ts` here, `BadgeProgressViewTests` in the launcher). Change the shares in one and
 * the other's table fails. The launcher also refuses a server age that disagrees with the badge
 * it draws, so a mismatch shows nothing rather than two different ages.</p>
 *
 * <p>Ages, top down: sovereign, imperial, industrial, fortress, colonial. Cumulative shares
 * 10 / 25 / 45 / 70 %, each cut rounded UP and at least one place past the previous one.</p>
 */

export type RankAge = 'sovereign' | 'imperial' | 'industrial' | 'fortress' | 'colonial';

/** Cumulative share of the table each age reaches, top down: sovereign … fortress. */
export const CUMULATIVE_SHARES = [0.10, 0.25, 0.45, 0.70] as const;

const ORDER: RankAge[] = ['sovereign', 'imperial', 'industrial', 'fortress', 'colonial'];

/** Last position of sovereign, imperial, industrial and fortress for a table of `size`. */
export function ageBounds(size: number): number[] {
    const out: number[] = [];
    let previous = 0;
    for (const share of CUMULATIVE_SHARES) {
        const cut = Math.ceil(size * share - 1e-9);
        previous = Math.max(previous + 1, cut);
        out.push(previous);
    }
    return out;
}

/** The age of a 1-based ladder position on a table of `size`. */
export function ageFor(position: number, size: number): RankAge {
    const b = ageBounds(size);
    for (let i = 0; i < b.length; i++) if (position <= b[i]!) return ORDER[i]!;
    return 'colonial';
}

export interface NextAgeTarget {
    /** The age one step up. */
    age: RankAge;
    /** The last place of that age: reaching it wears the badge. */
    atRank: number;
    /** Places between the player and that last place. */
    places: number;
}

/**
 * The next age up for a player at `position` on a table of `size`, or null at the top (or off
 * the table). The target is the LAST place of the next age, so passing whoever holds it now is
 * what earns the badge.
 */
export function nextAgeTarget(position: number, size: number): NextAgeTarget | null {
    if (!(position >= 1) || !(size >= 1) || position > size) return null;
    const b = ageBounds(size);
    for (let i = b.length - 1; i >= 0; i--) {
        if (position <= b[i]!) continue;
        return { age: ORDER[i]!, atRank: b[i]!, places: position - b[i]! };
    }
    return null;
}
