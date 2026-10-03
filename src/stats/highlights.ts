/**
 * Monthly highlights: who climbed the most, who played the most, and the best streak of the
 * month — on the launcher's Rooms page (design 55l) and, once a month, on Discord (55m).
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

export interface Highlights {
    month: string;
    starts_at: string;
    ends_at: string;
    /** True while the month is still running ("so far"). */
    so_far: boolean;
    total_rated: number;
    min_matches: number;
    biggest_climb: Record<RatingMode, ClimbHighlight | null>;
    most_matches: (PlayerRef & { matches: number }) | null;
    best_streak: Record<RatingMode, (PlayerRef & { wins: number }) | null>;
}

function better<T extends PlayerRef>(value: (x: T) => number) {
    return (a: T, b: T): number =>
        value(b) - value(a)
        || a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base' })
        || (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0);
}

/**
 * The pure rule. `rows` may hold the whole history (only the month's rows count; the ordinal is
 * what says whether a row came after the player's placement). Banned players must already be gone.
 */
export function computeHighlights(rows: readonly HighlightRow[], bounds: MonthBounds, nowMs: number): Highlights {
    const inMonth = rows.filter((r) => r.atMs >= bounds.startMs && r.atMs < bounds.endMs);
    const matchIds = new Set(inMonth.map((r) => r.match_id));

    const climb: Record<RatingMode, ClimbHighlight | null> = { default: null, team: null };
    const streak: Record<RatingMode, (PlayerRef & { wins: number }) | null> = { default: null, team: null };
    for (const mode of MODES) {
        const byUser = new Map<string, HighlightRow[]>();
        for (const r of inMonth) {
            if (r.mode !== mode) continue;
            const list = byUser.get(r.user_id) ?? [];
            list.push(r);
            byUser.set(r.user_id, list);
        }
        const climbs: ClimbHighlight[] = [];
        const streaks: Array<PlayerRef & { wins: number }> = [];
        for (const list of byUser.values()) {
            list.sort((a, b) => a.atMs - b.atMs || (a.match_id < b.match_id ? -1 : 1));
            const ref = { user_id: list[0]!.user_id, display_name: list[0]!.display_name, avatar_url: list[0]!.avatar_url };
            const placed = list.filter((r) => r.ordinal > placementRequired(mode));
            if (placed.length >= HIGHLIGHT_MIN_MATCHES) {
                const from = placed[0]!.rating_before;
                const to = placed[placed.length - 1]!.rating_after;
                const points = Math.round(to - from);
                if (points > 0) {
                    climbs.push({ ...ref, points, matches: placed.length, rating_from: Math.round(from), rating_to: Math.round(to) });
                }
            }
            const wins = bestWinRunWithin(list.map((r) => ({ atMs: r.atMs, result: r.result })), bounds.startMs, bounds.endMs);
            if (wins > 0) streaks.push({ ...ref, wins });
        }
        climb[mode] = climbs.sort(better((x) => x.points))[0] ?? null;
        streak[mode] = streaks.sort(better((x) => x.wins))[0] ?? null;
    }

    const counts = new Map<string, PlayerRef & { matches: number }>();
    for (const r of inMonth) {
        const c = counts.get(r.user_id) ?? { user_id: r.user_id, display_name: r.display_name, avatar_url: r.avatar_url, matches: 0 };
        c.matches += 1;
        counts.set(r.user_id, c);
    }
    const most = [...counts.values()].sort(better((x) => x.matches))[0] ?? null;

    return {
        month: bounds.month,
        starts_at: new Date(bounds.startMs).toISOString(),
        ends_at: new Date(bounds.endMs).toISOString(),
        so_far: nowMs < bounds.endMs,
        total_rated: matchIds.size,
        min_matches: HIGHLIGHT_MIN_MATCHES,
        biggest_climb: climb,
        most_matches: most,
        best_streak: streak,
    };
}

/** Every rated participation stored before `endMs`, with its ladder ordinal. Banned players excluded. */
export async function loadHighlightRows(ctx: AppContext, endMs: number): Promise<HighlightRow[]> {
    const rows = await ctx.db.prepare(
        `WITH rated AS (
             SELECT p.user_id, COALESCE(m.rating_mode, 'default') AS mode, m.id AS match_id,
                    m.created_at, p.result, p.rating_before, p.rating_after,
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
