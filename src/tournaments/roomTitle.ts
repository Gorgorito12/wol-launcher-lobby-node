/**
 * The title of a tournament room: `{tournament} · {round} · {entrant 1} · {entrant 2}`.
 *
 * <p><b>Why this is its own function.</b> The title used to be composed inline and cut with
 * `.slice(0, 80)` — the ordinary room limit — and the cut always landed on the LAST thing in
 * the string, which is the second entrant's name. A real final read
 * "… · UnstoppableStreletsy · Gommiusta": the one part of the title that identifies who is
 * playing lost its last letter, while the tournament's own name, which the bracket already
 * shows, survived whole.</p>
 *
 * <p><b>The rule: the entrants' names are never cut.</b> A tournament room gets a longer
 * limit ({@link TOURNAMENT_ROOM_TITLE_MAX}) and, when even that is not enough, the TOURNAMENT
 * name is shortened first, with an ellipsis. Only when two entrant names alone cannot fit —
 * two 80-character team names — are they shortened too, evenly, so neither side is the one
 * that loses.</p>
 *
 * <p>Lengths are UTF-16 code units, the unit every other title limit in this server uses,
 * and a cut never leaves half of a surrogate pair behind (a name may carry an emoji).</p>
 *
 * <p>Pure.</p>
 */

/** The longest title a tournament room may carry. Ordinary rooms keep 80. */
export const TOURNAMENT_ROOM_TITLE_MAX = 160;

const SEP = ' · ';
const ELLIPSIS = '…';

/** Below this the tournament name stops being worth keeping and the entrants start to give. */
const MIN_TOURNAMENT_PART = 12;

/** Cut `s` to at most `max` code units, ending in an ellipsis when anything was removed. */
export function shortenWithEllipsis(s: string, max: number): string {
    if (max <= 0) return '';
    if (s.length <= max) return s;
    if (max === 1) return ELLIPSIS;
    let cut = max - ELLIPSIS.length;
    // Never leave a lone high surrogate at the end.
    const last = s.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
    return s.slice(0, cut).trimEnd() + ELLIPSIS;
}

export function composeTournamentRoomTitle(
    tournamentName: string,
    roundLabel: string,
    entrant1: string,
    entrant2: string,
    max: number = TOURNAMENT_ROOM_TITLE_MAX,
): string {
    const name = tournamentName.trim();
    const round = roundLabel.trim();
    const e1 = entrant1.trim();
    const e2 = entrant2.trim();

    const tail = `${SEP}${round}${SEP}${e1}${SEP}${e2}`;
    if (name.length + tail.length <= max) return `${name}${tail}`;

    // The entrants fit; the tournament name gives way.
    const budget = max - tail.length;
    if (budget >= MIN_TOURNAMENT_PART) return `${shortenWithEllipsis(name, budget)}${tail}`;

    // Two very long entrant names: keep a stub of the tournament and share the rest evenly.
    const head = shortenWithEllipsis(name, MIN_TOURNAMENT_PART);
    const fixed = head.length + SEP.length * 3 + round.length;
    const each = Math.max(1, Math.floor((max - fixed) / 2));
    const shared = `${head}${SEP}${round}${SEP}${shortenWithEllipsis(e1, each)}${SEP}${shortenWithEllipsis(e2, each)}`;
    return shared.length <= max ? shared : shortenWithEllipsis(shared, max);
}
