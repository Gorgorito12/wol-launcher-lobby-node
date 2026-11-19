/**
 * Each entrant's tournament performance, for the detail (src/tournaments/rest.ts buildDetail),
 * once his run is over: knocked out, disqualified, withdrawn, or the tournament finished.
 *
 * <p>Only games that were PLAYED and RATED on the tournament's own ladder count, read from the
 * bracket's own `tournament_matches.match_id` — never the public match join, which hides private
 * tournaments. Walkovers, DQs, byes and organiser decisions count for nothing.</p>
 *
 * <p><b>Privacy, one rule:</b> no figure and no best win for an entrant when ANY rival he counted is
 * being placed now or keeps his rating private — for the entrant himself too, since his figure
 * plus the public results would solve for the hidden number. It appears by itself once the rival
 * finishes placement; the entry then carries `hidden: 'placement' | 'private'`.</p>
 */
import type { AppContext } from '../context';
import { combinedRd } from '../elo/glicko2';
import { placementRequired } from '../elo/placement';
import { isRatingPrivate } from '../elo/ratingPrivacy';
import type { BracketMatch } from './bracket';
import { tournamentPerformance, type Performance, type PerformanceGame } from './performance';

export type PerformanceEntry = Performance | { hidden: 'placement' | 'private' };

interface Row {
    slot: string;
    user_id: string;
    team: number | null;
    result: number;
    rating_before: number | null;
    rd_before: number | null;
    display_name: string | null;
}

export async function entrantPerformances(
    ctx: AppContext,
    t: { id: string; format: string; status: string },
    bracket: readonly BracketMatch[],
    entrants: readonly { id: string; display_name: string; status: string }[],
    rosters: ReadonlyMap<string, readonly { user_id: string }[]>,
): Promise<Map<string, PerformanceEntry>> {
    const out = new Map<string, PerformanceEntry>();
    const mode = t.format === '1v1' ? 'default' : 'team';
    const finished = t.status === 'finished';
    const runOver = (id: string, status: string) =>
        finished || status === 'disqualified' || status === 'withdrawn'
        || bracket.some((m) => m.winnerEntrantId && m.winnerEntrantId !== id
            && (m.entrant1Id === id || m.entrant2Id === id));
    const over = entrants.filter((e) => runOver(e.id, e.status));
    if (over.length === 0) return out;

    let rows: Row[];
    try {
        const res = await ctx.db.prepare(
            `SELECT tm.id AS slot, mp.user_id, mp.team, mp.result, mp.rating_before, mp.rd_before,
                    u.display_name
               FROM tournament_matches tm
               JOIN matches m ON m.id = tm.match_id
               JOIN match_participants mp ON mp.match_id = m.id
               JOIN users u ON u.id = mp.user_id
              WHERE tm.tournament_id = ? AND tm.outcome = 'played'
                AND m.rated = 1 AND COALESCE(m.rating_mode, 'default') = ?`,
        ).bind(t.id, mode).all<Row>();
        rows = res.results ?? [];
    } catch {
        return out;
    }
    if (rows.length === 0) return out;

    // Who is being placed NOW on this ladder: their number may not come back through anybody's figure.
    const ids = [...new Set(rows.map((r) => r.user_id))];
    const placing = new Set<string>();
    try {
        const marks = ids.map(() => '?').join(', ');
        const pr = await ctx.db.prepare(
            `SELECT user_id, games_played FROM player_ratings WHERE mode = ? AND user_id IN (${marks})`,
        ).bind(mode, ...ids).all<{ user_id: string; games_played: number }>();
        const required = placementRequired(mode);
        const played = new Map((pr.results ?? []).map((r) => [r.user_id, r.games_played] as [string, number]));
        for (const id of ids) {
            const n = played.get(id) ?? 0;
            if (n < required) placing.add(id);
        }
    } catch {
        return out;
    }

    const entrantOf = new Map<string, string>();
    for (const [eid, members] of rosters) for (const m of members) entrantOf.set(m.user_id, eid);
    const nameOf = new Map(entrants.map((e) => [e.id, e.display_name] as [string, string]));
    const bySlot = new Map<string, Row[]>();
    for (const r of rows) {
        const list = bySlot.get(r.slot) ?? [];
        list.push(r);
        bySlot.set(r.slot, list);
    }

    for (const e of over) {
        const members = new Set((rosters.get(e.id) ?? []).map((m) => m.user_id));
        const games: PerformanceGame[] = [];
        let hidden: 'placement' | 'private' | null = null;
        for (const parts of bySlot.values()) {
            const mine = parts.filter((p) => members.has(p.user_id));
            if (mine.length === 0) continue;
            const myTeam = mine[0]!.team;
            const opp = parts.filter((p) => !members.has(p.user_id)
                && (t.format === '1v1' || myTeam == null || p.team !== myTeam));
            if (opp.length === 0 || opp.some((p) => p.rating_before == null)) continue;
            if (opp.some((p) => isRatingPrivate(p.user_id))) hidden = 'private';
            else if (!hidden && opp.some((p) => placing.has(p.user_id))) hidden = 'placement';
            const oppRating = opp.reduce((s, p) => s + p.rating_before!, 0) / opp.length;
            const rds = opp.map((p) => p.rd_before);
            const oppRd = rds.every((r): r is number => r != null)
                ? (opp.length === 1 ? rds[0]! : combinedRd(rds)) : null;
            const oppEntrant = entrantOf.get(opp[0]!.user_id);
            const oppName = t.format === '1v1'
                ? (opp[0]!.display_name ?? (oppEntrant ? nameOf.get(oppEntrant) : null) ?? '')
                : (oppEntrant ? nameOf.get(oppEntrant) ?? '' : '');
            games.push({ oppRating, oppRd, score: mine[0]!.result, oppName });
        }
        if (games.length === 0) continue;
        if (hidden) { out.set(e.id, { hidden }); continue; }
        const perf = tournamentPerformance(games);
        if (perf) out.set(e.id, perf);
    }
    return out;
}
