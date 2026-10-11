/**
 * "This game was played for a bracket" — the one shape every match list sends.
 *
 * <p>The History has carried `tournament: {id, name, round, rounds_total}` since tournaments
 * existed, but the two COMMUNITY lists — `/stats/community`'s `recent_matches` (the Rooms page's
 * "Latest matches" and Ranking's) and `GET /matches` — never did, so a tournament final sat in
 * them as one more "COMPETITIVE 1v1", indistinguishable from a friendly. All three now build it
 * here, from the same joined columns, so they can never describe one match two ways.</p>
 *
 * <p>The SQL half is {@link TOURNAMENT_REF_COLUMNS} + {@link TOURNAMENT_REF_JOIN}; the query
 * must alias the matches table `m`.</p>
 *
 * <p>Pure.</p>
 */

/** The columns to select. Removed from the row by {@link withTournamentRef}. */
export const TOURNAMENT_REF_COLUMNS =
    `t.id AS tournament_id, t.name AS tournament_name,
     tm.round AS tournament_round, t.bracket_size AS tournament_bracket_size`;

/** LEFT, both: an ordinary match has no bracket slot and must still be listed. */
export const TOURNAMENT_REF_JOIN =
    `LEFT JOIN tournament_matches tm ON tm.id = m.tournament_match_id
     LEFT JOIN tournaments t ON t.id = tm.tournament_id`;

export interface TournamentRef {
    id: string;
    name: string;
    round: number | null;
    rounds_total: number | null;
}

/** The bracket a row was played for, or null for an ordinary match. */
export function tournamentRefOf(row: {
    tournament_id?: unknown;
    tournament_name?: unknown;
    tournament_round?: unknown;
    tournament_bracket_size?: unknown;
}): TournamentRef | null {
    if (typeof row.tournament_id !== 'string' || !row.tournament_id) return null;
    const size = row.tournament_bracket_size;
    return {
        id: row.tournament_id,
        name: typeof row.tournament_name === 'string' ? row.tournament_name : '',
        round: typeof row.tournament_round === 'number' ? row.tournament_round : null,
        rounds_total: typeof size === 'number' && size > 1 ? Math.round(Math.log2(size)) : null,
    };
}

/**
 * The row with its four tournament columns folded into one `tournament` field — what the
 * launcher reads — and nothing else changed.
 */
export function withTournamentRef<T extends Record<string, unknown>>(row: T): Omit<T,
    'tournament_id' | 'tournament_name' | 'tournament_round' | 'tournament_bracket_size'>
    & { tournament: TournamentRef | null } {
    const {
        tournament_id, tournament_name, tournament_round, tournament_bracket_size, ...rest
    } = row;
    return {
        ...rest,
        tournament: tournamentRefOf({
            tournament_id, tournament_name, tournament_round, tournament_bracket_size,
        }),
    };
}
