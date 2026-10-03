/**
 * Monthly highlights: who climbed the most, who won and played the most, the best win rate and
 * streak, the civilization of the month and its biggest upset — on the launcher's Rooms page
 * (design 55l) and, once a month, on Discord (55m). The Discord message names only the first
 * three; the rest are launcher-only.
 *
 * <p><b>A month</b> runs from the 1st at 06:00 UTC to the next 1st at 06:00 UTC: midnight in
 * Central America and Mexico, already that day everywhere in Latin America and in Spain. The same
 * hour the community already knew from the season boundaries.</p>
 *
 * <p><b>The rules.</b></p>
 * <ul>
 *   <li><b>Biggest climb</b>, PER LADDER: the rating after a player's last rated match of the month
 *       minus the rating before his first one, counting only matches played AFTER his placement
 *       (a newcomer's first matches swing hundreds of points by design, and nobody in placement
 *       takes part). At least {@link HIGHLIGHT_MIN_MATCHES} such matches in the month, and a
 *       positive climb. The launcher shows the bigger of the two ladders.</li>
 *   <li><b>Most matches</b>: rated matches of both ladders.</li>
 *   <li><b>Best streak of the month</b>, per ladder: the longest run of wins whose matches are all
 *       inside the month (src/elo/streaks.ts, bestWinRunWithin).</li>
 *   <li><b>Most wins</b>: rated wins of both ladders. A tie goes to whoever played FEWER matches —
 *       the same number of wins out of fewer games is the better month.</li>
 *   <li><b>Best win rate</b>: rated wins over rated matches, both ladders, for players with at
 *       least {@link HIGHLIGHT_MIN_RATE_MATCHES} matches in the month, so a 2-0 cannot top it.</li>
 *   <li><b>Civilization of the month</b>: the most picked civilization in rated matches, per
 *       (mod, civ) — two mods can share a name and are not the same civilization. Blank civs are
 *       ignored, and it needs {@link HIGHLIGHT_MIN_CIV_PICKS} picks. The only community figure here:
 *       it names no player.</li>
 *   <li><b>Biggest upset</b>: the rated match won by the side whose average rating before it was
 *       furthest BELOW the losers'. Only matches in which every participant had finished placement
 *       count — a newcomer's rating is a starting guess, and beating someone "200 above" him says
 *       nothing yet.</li>
 * </ul>
 * <p>Banned players never appear. A tie goes to the bigger value, then by name, then by id, so the
 * same data always names the same player.</p>
 *
 * <p>Computed on read and memoised; there is no timer. The pure half ({@link computeHighlights},
 * {@link renderDiscord}) is what the tests pin.</p>
 */
import type { AppContext } from '../context';
import { toSqliteText } from '../lib/time';
import { placementRequired } from '../elo/placement';
import { bestWinRunWithin } from '../elo/streaks';
import type { RatingMode } from '../elo/glicko2';

/** Fewest post-placement rated matches in the month for "biggest climb". */
export const HIGHLIGHT_MIN_MATCHES = 5;

/** Fewest rated matches in the month for "best win rate". */
export const HIGHLIGHT_MIN_RATE_MATCHES = 10;

/** Fewest picks in the month for "civilization of the month". */
export const HIGHLIGHT_MIN_CIV_PICKS = 3;

/** How many entries each top list of the ranking's Highlights view carries. */
export const HIGHLIGHT_LEADERS = 5;

/** The boundary hour, UTC. */
const BOUNDARY_HOUR = 6;

const MODES: readonly RatingMode[] = ['default', 'team'];

export interface MonthBounds {
    /** 'YYYY-MM' */
    month: string;
    startMs: number;
    endMs: number;
}

/** The month an instant belongs to: before 06:00 UTC on the 1st, it is still the previous one. */
export function monthOf(ms: number): string {
    const d = new Date(ms - BOUNDARY_HOUR * 60 * 60 * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthBounds(month: string): MonthBounds {
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    if (!m) throw new Error(`bad month ${month}`);
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    return {
        month,
        startMs: Date.UTC(y, mo, 1, BOUNDARY_HOUR),
        endMs: Date.UTC(y, mo + 1, 1, BOUNDARY_HOUR),
    };
}

export function previousMonth(month: string): string {
    const b = monthBounds(month);
    return monthOf(b.startMs - 1);
}

/** One rated participation, with its ordinal on that ladder (1 = the player's first rated match). */
export interface HighlightRow {
    user_id: string;
    display_name: string;
    avatar_url: string | null;
    mode: RatingMode;
    atMs: number;
    result: number;
    rating_before: number;
    rating_after: number;
    ordinal: number;
    match_id: string;
    /** The civilization this player played, as the report stored it; null or blank when unknown. */
    civ?: string | null;
    /** The match's mod. */
    mod_id?: string;
}

export interface PlayerRef {
    user_id: string;
    display_name: string;
    avatar_url: string | null;
}

export interface ClimbHighlight extends PlayerRef {
    points: number;
    matches: number;
    rating_from: number;
    rating_to: number;
}

export interface CivHighlight {
    mod_id: string;
    civ: string;
    picks: number;
    wins: number;
}

export interface UpsetHighlight {
    mode: RatingMode;
    match_id: string;
    /** Losers' average rating before the match minus the winners', rounded; at least 1. */
    gap: number;
    winners: PlayerRef[];
    losers: PlayerRef[];
    winners_rating: number;
    losers_rating: number;
}

/** One month's top lists — the ranking's Highlights view reads these (GET /stats/highlights). */
export interface HighlightLeaders {
    biggest_climb: Record<RatingMode, ClimbHighlight[]>;
    most_wins: Array<PlayerRef & { wins: number; matches: number }>;
    most_matches: Array<PlayerRef & { matches: number; wins: number }>;
    best_streak: Record<RatingMode, Array<PlayerRef & { wins: number }>>;
    best_win_rate: Array<PlayerRef & { wins: number; matches: number; percent: number }>;
    top_civ: CivHighlight[];
    biggest_upset: UpsetHighlight[];
}

export interface Highlights {
    month: string;
    starts_at: string;
    ends_at: string;
    /** True while the month is still running ("so far"). */
    so_far: boolean;
    total_rated: number;
    min_matches: number;
    /** The thresholds of the best win rate and the civilization of the month, sent so the
     *  launcher states them without keeping a copy that could drift. */
    min_rate_matches: number;
    min_civ_picks: number;
    biggest_climb: Record<RatingMode, ClimbHighlight | null>;
    most_matches: (PlayerRef & { matches: number; wins: number }) | null;
    best_streak: Record<RatingMode, (PlayerRef & { wins: number }) | null>;
    most_wins: (PlayerRef & { wins: number; matches: number }) | null;
    best_win_rate: (PlayerRef & { wins: number; matches: number; percent: number }) | null;
    top_civ: CivHighlight | null;
    biggest_upset: UpsetHighlight | null;
    /**
     * The top {@link HIGHLIGHT_LEADERS} of every category. The singular fields above are DERIVED
     * from these lists (their first entry), never computed apart, so the two cannot disagree.
     * `/stats/community` strips this before sending ({@link withoutLeaders}): every launcher asks
     * for that payload once a minute, and only the ranking's Highlights view needs the lists.
     */
    leaders: HighlightLeaders;
}

function better<T extends PlayerRef>(value: (x: T) => number) {
    return (a: T, b: T): number =>
        value(b) - value(a)
        || a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base' })
        || (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0);
}

/** The first `HIGHLIGHT_LEADERS` of a list already in order. */
function top<T>(sorted: T[]): T[] {
    return sorted.slice(0, HIGHLIGHT_LEADERS);
}

/**
 * The pure rule. `rows` may hold the whole history (only the month's rows count; the ordinal is
 * what says whether a row came after the player's placement). Banned players must already be gone.
 */
export function computeHighlights(rows: readonly HighlightRow[], bounds: MonthBounds, nowMs: number): Highlights {
    const inMonth = rows.filter((r) => r.atMs >= bounds.startMs && r.atMs < bounds.endMs);
    const matchIds = new Set(inMonth.map((r) => r.match_id));

    const climbs: Record<RatingMode, ClimbHighlight[]> = { default: [], team: [] };
    const streaks: Record<RatingMode, Array<PlayerRef & { wins: number }>> = { default: [], team: [] };
    for (const mode of MODES) {
        const byUser = new Map<string, HighlightRow[]>();
        for (const r of inMonth) {
            if (r.mode !== mode) continue;
            const list = byUser.get(r.user_id) ?? [];
            list.push(r);
            byUser.set(r.user_id, list);
        }
        const modeClimbs: ClimbHighlight[] = [];
        const modeStreaks: Array<PlayerRef & { wins: number }> = [];
        for (const list of byUser.values()) {
            list.sort((a, b) => a.atMs - b.atMs || (a.match_id < b.match_id ? -1 : 1));
            const ref = { user_id: list[0]!.user_id, display_name: list[0]!.display_name, avatar_url: list[0]!.avatar_url };
            const placed = list.filter((r) => r.ordinal > placementRequired(mode));
            if (placed.length >= HIGHLIGHT_MIN_MATCHES) {
                const from = placed[0]!.rating_before;
                const to = placed[placed.length - 1]!.rating_after;
                const points = Math.round(to - from);
                if (points > 0) {
                    modeClimbs.push({ ...ref, points, matches: placed.length, rating_from: Math.round(from), rating_to: Math.round(to) });
                }
            }
            const wins = bestWinRunWithin(list.map((r) => ({ atMs: r.atMs, result: r.result })), bounds.startMs, bounds.endMs);
            if (wins > 0) modeStreaks.push({ ...ref, wins });
        }
        climbs[mode] = top(modeClimbs.sort(better((x) => x.points)));
        streaks[mode] = top(modeStreaks.sort(better((x) => x.wins)));
    }

    const tally = new Map<string, PlayerRef & { wins: number; matches: number }>();
    for (const r of inMonth) {
        const t = tally.get(r.user_id) ?? { user_id: r.user_id, display_name: r.display_name, avatar_url: r.avatar_url, wins: 0, matches: 0 };
        t.matches += 1;
        if (r.result >= 0.999) t.wins += 1;
        tally.set(r.user_id, t);
    }
    const players = [...tally.values()];
    const mostMatches = top([...players].sort(better((x) => x.matches)))
        .map((p) => ({ user_id: p.user_id, display_name: p.display_name, avatar_url: p.avatar_url, matches: p.matches, wins: p.wins }));
    const mostWins = top(players
        .filter((p) => p.wins > 0)
        .sort((a, b) => b.wins - a.wins || a.matches - b.matches || byName(a, b)))
        .map((p) => ({ ...p }));
    const bestRate = top(players
        .filter((p) => p.matches >= HIGHLIGHT_MIN_RATE_MATCHES)
        .sort((a, b) => b.wins / b.matches - a.wins / a.matches || b.matches - a.matches || byName(a, b)))
        .map((p) => ({ ...p, percent: Math.round((100 * p.wins) / p.matches) }));

    const leaders: HighlightLeaders = {
        biggest_climb: climbs,
        most_wins: mostWins,
        most_matches: mostMatches,
        best_streak: streaks,
        best_win_rate: bestRate,
        top_civ: topCivs(inMonth),
        biggest_upset: biggestUpsets(inMonth),
    };

    return {
        month: bounds.month,
        starts_at: new Date(bounds.startMs).toISOString(),
        ends_at: new Date(bounds.endMs).toISOString(),
        so_far: nowMs < bounds.endMs,
        total_rated: matchIds.size,
        min_matches: HIGHLIGHT_MIN_MATCHES,
        min_rate_matches: HIGHLIGHT_MIN_RATE_MATCHES,
        min_civ_picks: HIGHLIGHT_MIN_CIV_PICKS,
        biggest_climb: { default: climbs.default[0] ?? null, team: climbs.team[0] ?? null },
        most_matches: mostMatches[0] ?? null,
        best_streak: { default: streaks.default[0] ?? null, team: streaks.team[0] ?? null },
        most_wins: mostWins[0] ?? null,
        best_win_rate: bestRate[0] ?? null,
        top_civ: leaders.top_civ[0] ?? null,
        biggest_upset: leaders.biggest_upset[0] ?? null,
        leaders,
    };
}

/** The same month without its top lists — what `/stats/community` sends. */
export function withoutLeaders(h: Highlights): Omit<Highlights, 'leaders'> {
    const { leaders: _leaders, ...rest } = h;
    return rest;
}

/** This month and the last as `/stats/community` sends them: without their top lists. */
export function forCommunity(
    pair: { current: Highlights; previous: Highlights } | null,
): { current: Omit<Highlights, 'leaders'>; previous: Omit<Highlights, 'leaders'> } | null {
    return pair ? { current: withoutLeaders(pair.current), previous: withoutLeaders(pair.previous) } : null;
}

function byName(a: PlayerRef, b: PlayerRef): number {
    return a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base' })
        || (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0);
}

/** The most picked civilizations of the month, per (mod, civ), most picked first. */
export function topCivs(inMonth: readonly HighlightRow[]): CivHighlight[] {
    const picks = new Map<string, CivHighlight>();
    for (const r of inMonth) {
        const civ = (r.civ ?? '').trim();
        if (!civ) continue;
        const mod = r.mod_id ?? '';
        const key = `${mod}\u0000${civ}`;
        const c = picks.get(key) ?? { mod_id: mod, civ, picks: 0, wins: 0 };
        c.picks += 1;
        if (r.result >= 0.999) c.wins += 1;
        picks.set(key, c);
    }
    return top([...picks.values()]
        .filter((c) => c.picks >= HIGHLIGHT_MIN_CIV_PICKS)
        .sort((a, b) => b.picks - a.picks || b.wins - a.wins
            || a.civ.localeCompare(b.civ, undefined, { sensitivity: 'base' })
            || (a.mod_id < b.mod_id ? -1 : a.mod_id > b.mod_id ? 1 : 0)));
}

/** The most picked civilization of the month (the first of {@link topCivs}). */
export function topCiv(inMonth: readonly HighlightRow[]): CivHighlight | null {
    return topCivs(inMonth)[0] ?? null;
}

/**
 * The matches won by the side furthest below the losers, on the average rating before them,
 * biggest gap first. Every participant must have finished placement on that ladder, and both
 * sides must be present.
 */
export function biggestUpsets(inMonth: readonly HighlightRow[]): UpsetHighlight[] {
    const byMatch = new Map<string, HighlightRow[]>();
    for (const r of inMonth) {
        const list = byMatch.get(r.match_id) ?? [];
        list.push(r);
        byMatch.set(r.match_id, list);
    }
    const avg = (rows: readonly HighlightRow[]) => rows.reduce((s, r) => s + r.rating_before, 0) / rows.length;
    const ref = (r: HighlightRow): PlayerRef => ({ user_id: r.user_id, display_name: r.display_name, avatar_url: r.avatar_url });
    const upsets: UpsetHighlight[] = [];
    for (const [matchId, rows] of byMatch) {
        const mode = rows[0]!.mode;
        if (rows.some((r) => r.ordinal <= placementRequired(mode))) continue;
        const winners = rows.filter((r) => r.result >= 0.999);
        const losers = rows.filter((r) => r.result <= 0.001);
        if (winners.length === 0 || losers.length === 0 || winners.length + losers.length !== rows.length) continue;
        const winnersRating = avg(winners);
        const losersRating = avg(losers);
        const gap = Math.round(losersRating - winnersRating);
        if (gap < 1) continue;
        const sorted = (list: HighlightRow[]) => [...list].sort((a, b) => byName(ref(a), ref(b))).map(ref);
        upsets.push({
            mode,
            match_id: matchId,
            gap,
            winners: sorted(winners),
            losers: sorted(losers),
            winners_rating: Math.round(winnersRating),
            losers_rating: Math.round(losersRating),
        });
    }
    return top(upsets.sort((a, b) => b.gap - a.gap || (a.match_id < b.match_id ? -1 : a.match_id > b.match_id ? 1 : 0)));
}

/** The biggest upset of the month (the first of {@link biggestUpsets}). */
export function biggestUpset(inMonth: readonly HighlightRow[]): UpsetHighlight | null {
    return biggestUpsets(inMonth)[0] ?? null;
}

/** Every rated participation stored before `endMs`, with its ladder ordinal. Banned players excluded. */
export async function loadHighlightRows(ctx: AppContext, endMs: number): Promise<HighlightRow[]> {
    const rows = await ctx.db.prepare(
        `WITH rated AS (
             SELECT p.user_id, COALESCE(m.rating_mode, 'default') AS mode, m.id AS match_id,
                    m.created_at, p.result, p.rating_before, p.rating_after, p.civ, m.mod_id,
                    ROW_NUMBER() OVER (PARTITION BY p.user_id, COALESCE(m.rating_mode, 'default')
                                       ORDER BY m.created_at, m.id) AS ordinal
               FROM matches m JOIN match_participants p ON p.match_id = m.id
              WHERE m.rated = 1 AND m.created_at < ?
                AND p.rating_before IS NOT NULL AND p.rating_after IS NOT NULL)
         SELECT r.*, u.display_name, u.avatar_url
           FROM rated r JOIN users u ON u.id = r.user_id
          WHERE u.is_banned = 0`,
    ).bind(toSqliteText(endMs)).all<{
        user_id: string; mode: string; match_id: string; created_at: string; result: number;
        rating_before: number; rating_after: number; ordinal: number;
        civ: string | null; mod_id: string;
        display_name: string; avatar_url: string | null;
    }>();
    return (rows.results ?? []).map((r) => ({
        user_id: r.user_id,
        display_name: r.display_name,
        avatar_url: r.avatar_url,
        mode: r.mode === 'team' ? 'team' : 'default',
        atMs: Date.parse(`${r.created_at.replace(' ', 'T')}Z`),
        result: r.result,
        rating_before: r.rating_before,
        rating_after: r.rating_after,
        ordinal: r.ordinal,
        match_id: r.match_id,
        civ: r.civ,
        mod_id: r.mod_id,
    }));
}

export async function highlightsFor(ctx: AppContext, month: string, nowMs: number): Promise<Highlights> {
    const bounds = monthBounds(month);
    const rows = await loadHighlightRows(ctx, bounds.endMs);
    return computeHighlights(rows, bounds, nowMs);
}

// ---------------------------------------------------------------- Discord

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];

function monthName(month: string, lang: 'es' | 'en'): string {
    const i = Number(month.slice(5, 7)) - 1;
    return lang === 'es' ? MONTHS_ES[i]! : MONTHS_EN[i]!;
}

function modeName(mode: RatingMode, lang: 'es' | 'en'): string {
    return mode === 'team' ? (lang === 'es' ? 'Equipos' : 'Teams') : '1v1';
}

function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
}

function pickBest<T>(byMode: Record<RatingMode, T | null>, value: (x: T) => number): [RatingMode, T] | null {
    const a = byMode.default;
    const b = byMode.team;
    if (a && (!b || value(a) >= value(b))) return ['default', a];
    if (b) return ['team', b];
    return null;
}

/**
 * The monthly Discord message, in the maintainer's words (design handoff, §10). A line with nobody
 * to name is left out; null when the month had no rated match at all — nothing is posted then.
 */
export function renderDiscord(h: Highlights, lang: 'es' | 'en'): string | null {
    if (h.total_rated <= 0) return null;
    const lines: string[] = [];
    const climb = pickBest(h.biggest_climb, (x) => x.points);
    const streak = pickBest(h.best_streak, (x) => x.wins);
    if (lang === 'es') {
        lines.push(`🏆 Destacados de ${monthName(h.month, 'es')}`);
        if (climb) {
            const [mode, c] = climb;
            lines.push(`📈 Quién más subió: ${c.display_name}, +${c.points} ELO en ${modeName(mode, 'es')} en ${plural(c.matches, 'partida puntuada', 'partidas puntuadas')}`);
        }
        if (h.most_matches) {
            lines.push(`⚔️ Más partidas: ${h.most_matches.display_name}, ${plural(h.most_matches.matches, 'partida puntuada', 'partidas puntuadas')}`);
        }
        if (streak) {
            const [mode, s] = streak;
            lines.push(`🔥 Mejor racha: ${s.display_name}, ${plural(s.wins, 'victoria seguida', 'victorias seguidas')} en ${modeName(mode, 'es')}`);
        }
        lines.push(`${plural(h.total_rated, 'partida puntuada', 'partidas puntuadas')} este mes. La clasificación completa está en el launcher, pestaña Clasificación.`);
    } else {
        const name = monthName(h.month, 'en');
        lines.push(`🏆 ${name} highlights`);
        if (climb) {
            const [mode, c] = climb;
            lines.push(`📈 Biggest climb: ${c.display_name}, +${c.points} ELO in ${modeName(mode, 'en')} over ${plural(c.matches, 'rated match', 'rated matches')}`);
        }
        if (h.most_matches) {
            lines.push(`⚔️ Most matches: ${h.most_matches.display_name}, ${plural(h.most_matches.matches, 'rated match', 'rated matches')}`);
        }
        if (streak) {
            const [mode, s] = streak;
            lines.push(`🔥 Best streak: ${s.display_name}, ${plural(s.wins, 'win in a row', 'wins in a row')} in ${modeName(mode, 'en')}`);
        }
        lines.push(`${plural(h.total_rated, 'rated match', 'rated matches')} this month. The full ranking is in the launcher, Ranking tab.`);
    }
    return lines.join('\n');
}
