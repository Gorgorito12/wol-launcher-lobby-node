/**
 * The medals a player's history satisfies, game by game. Pure: store.ts loads the rows, this
 * decides, the store writes.
 *
 * <p><b>Idempotent by construction.</b> Every counter is re-derived from the stored matches each
 * time, and the writer only ever INSERT OR IGNOREs, so running this twice, or after a late rating,
 * a civilization filled in, or a whole ladder replay, hands out nothing twice. It never takes a
 * medal back: a medal that stopped being satisfied (a voided match) stays where it was written.</p>
 *
 * <p><b>Per game on one ladder.</b> There is one 1v1 ladder and one team ladder for all mods, so a
 * ladder fact counts for the game of the match that produced it: the rating a player reached
 * after WINNING a rated match of this game, the placement finished in a match of this game, the
 * age held after his latest rated match — which is in some game.</p>
 */
import {
    allOf, catalogFor, civKey, collectorGoal, mapKey, CIV_LISTS, MAP_LISTS, PROMOTION_TIERS, TAD_FAMILIES,
    type AchievementDef, type CivFamily, type Ladder,
} from './catalog';
import {
    DURATION_UNTRUSTED_DECIDERS, eloAllowsMedal, isCountable, LOSS_AT, MEDAL_WINS_PER_RIVAL_PER_DAY,
    MIN_LADDER_FOR_POSITION_MEDALS, utcDay, WIN_AT,
} from './rules';
import { placementRequired } from '../elo/placement';
import { ageFor } from '../elo/ages';
import { STREAK_IDLE_CUTOFF_MS } from '../elo/streaks';

export interface OtherPlayer {
    userId: string;
    team: number | null;
    civ: string | null;
    result: number;
    ratingBefore: number | null;
}

/** One match of the player, from his side. */
export interface MatchRow {
    matchId: string;
    atMs: number;
    modKey: string;
    mapName: string | null;
    durationSeconds: number | null;
    rated: number | null;
    unratedReason: string | null;
    decidedBy: string | null;
    ratingMode: Ladder;
    eloFactor: number | null;
    lobbyId: string | null;
    gameRules: number | null;
    rosterOk: boolean;
    team: number | null;
    civ: string | null;
    result: number;
    ratingBefore: number | null;
    ratingAfter: number | null;
    others: OtherPlayer[];
    /** The room was opened by the quick-match queue (lobbies.matchmaking_match_id). */
    quickMatch?: boolean;
}

export interface DatedEvent {
    modKey: string;
    atMs: number;
    lobbyId?: string;
    tournamentId?: string;
}

export interface LadderPosition {
    /** 1-based place on the table; 0 or absent = not on it. */
    rank: number;
    size: number;
}

export interface EvalInput {
    userId: string;
    nowMs: number;
    /** Every match of the player, every game, oldest first (created_at, id). */
    matches: MatchRow[];
    /** Rooms he created that were played, one per room, oldest first. */
    hostedRooms: DatedEvent[];
    /** Finished tournaments he won / organised that qualify. */
    championOf: DatedEvent[];
    organiserOf: DatedEvent[];
    /** Qualifying tournaments he played a game in, and those whose final he played. */
    tournamentsPlayed?: DatedEvent[];
    finalistOf?: DatedEvent[];
    /** His rated games on each ladder, from player_ratings (placement is about the ladder, not the game). */
    gamesPlayed: Record<Ladder, number>;
    /** The medals already stored for him, not revoked, by game, as "id|tier" (for "Living Legend"). */
    held?: Readonly<Record<string, readonly string[]>>;
    /** Where he stands right now, when known. Absent = not evaluated (the backfill of old rows). */
    position?: Partial<Record<Ladder, LadderPosition>>;
}

export interface Earned {
    tier: number;
    atMs: number;
    matchId?: string;
    tournamentId?: string;
}

export interface ItemProgress {
    def: AchievementDef;
    /** Progress toward the goal; absent for yes/no medals. */
    value?: number;
    goal?: number;
    /** The tiers the history satisfies now, with the match that crossed each. */
    earned: Earned[];
    /** The highest Promotion tier held now (0 = none). */
    tierNow?: number;
    /** Why no number can be shown yet. */
    locked?: 'placement';
}

export type ModProgress = Map<string, ItemProgress>;

/** The games this player has anything in, most played first, ties by the latest match. */
export function modsOf(input: EvalInput): string[] {
    const count = new Map<string, { n: number; last: number }>();
    const bump = (k: string, at: number, by: number) => {
        if (!k) return;
        const c = count.get(k) ?? { n: 0, last: 0 };
        c.n += by;
        c.last = Math.max(c.last, at);
        count.set(k, c);
    };
    for (const m of input.matches) bump(m.modKey, m.atMs, isCountable(m) ? 1 : 0);
    for (const e of [...input.hostedRooms, ...input.championOf, ...input.organiserOf,
        ...(input.tournamentsPlayed ?? []), ...(input.finalistOf ?? [])]) bump(e.modKey, e.atMs, 0);
    return [...count.entries()]
        .sort((x, y) => y[1].n - x[1].n || y[1].last - x[1].last || (x[0] < y[0] ? -1 : 1))
        .map(([k]) => k);
}

/** Who he played against: the other side, or everybody else when the match had one side. */
function opponentsOf(m: MatchRow): OtherPlayer[] {
    const distinctTeams = new Set([m.team, ...m.others.map((o) => o.team)]);
    if (distinctTeams.size < 2) return m.others;
    return m.others.filter((o) => o.team !== m.team);
}

/** "1v1", "2v2", "3v3" when the match had two sides of the same size, else ''. */
function formatOf(m: MatchRow): string {
    const opp = opponentsOf(m).length;
    const mine = 1 + m.others.length - opp;
    return opp > 0 && opp === mine ? `${mine}v${opp}` : '';
}

function isTeamMatch(m: MatchRow): boolean {
    if (m.ratingMode === 'team' && m.rated === 1) return true;
    const distinctTeams = new Set([m.team, ...m.others.map((o) => o.team)]);
    return distinctTeams.size >= 2 && m.others.some((o) => o.team === m.team);
}

/** The rated ordinal of every rated match on its ladder, across all games (the placement count). */
function ladderOrdinals(matches: readonly MatchRow[]): Map<string, number> {
    const n: Record<Ladder, number> = { default: 0, team: 0 };
    const out = new Map<string, number>();
    for (const m of matches) {
        if (m.rated !== 1) continue;
        n[m.ratingMode] += 1;
        out.set(m.matchId, n[m.ratingMode]);
    }
    return out;
}

const familyOf = (key: string): CivFamily | null => {
    for (const f of Object.keys(TAD_FAMILIES) as CivFamily[]) if (TAD_FAMILIES[f].includes(key)) return f;
    return null;
};

const inSet = (key: string, wanted: CivFamily | readonly string[]): boolean =>
    typeof wanted === 'string' ? familyOf(key) === wanted : wanted.includes(key);

/** Counts toward the goal-th item, remembering the row that reached it. */
class Counter {
    n = 0;
    at: Earned | null = null;
    private readonly goal: number;
    constructor(goal: number) { this.goal = goal; }
    add(m: MatchRow): void {
        this.n += 1;
        if (this.at === null && this.n >= this.goal) this.at = { tier: 0, atMs: m.atMs, matchId: m.matchId };
    }
}

/** A set that remembers when it first held `goal` members. */
class DistinctCounter {
    readonly seen = new Set<string>();
    at: Earned | null = null;
    private readonly goal: number;
    private readonly only: readonly string[] | undefined;
    constructor(goal: number, only?: readonly string[]) {
        this.goal = goal;
        this.only = only;
    }
    add(key: string, m: MatchRow): void {
        if (!key || (this.only && !this.only.includes(key))) return;
        this.seen.add(key);
        if (this.at === null && this.goal > 0 && this.seen.size >= this.goal) {
            this.at = { tier: 0, atMs: m.atMs, matchId: m.matchId };
        }
    }
}

/**
 * The progress of every medal of every game the player has played, plus the game his current
 * ladder places belong to.
 */
export function evaluate(input: EvalInput): Map<string, ModProgress> {
    const out = new Map<string, ModProgress>();
    const ordinals = ladderOrdinals(input.matches);

    // Which game his place on each ladder belongs to: the game of his latest rated match on it.
    const positionMod: Partial<Record<Ladder, string>> = {};
    for (const m of input.matches) if (m.rated === 1) positionMod[m.ratingMode] = m.modKey;

    for (const modKey of modsOf(input)) {
        out.set(modKey, evaluateMod(input, modKey, ordinals, positionMod));
    }
    return out;
}

function evaluateMod(
    input: EvalInput,
    modKey: string,
    ordinals: Map<string, number>,
    positionMod: Partial<Record<Ladder, string>>,
): ModProgress {
    const rows = input.matches.filter((m) => m.modKey === modKey && isCountable(m));

    // Which wins count: the ELO's own discount, then at most N a day against one opposing side.
    const perRivalDay = new Map<string, number>();
    const counted = new Set<string>();
    for (const m of rows) {
        if (!(m.result >= WIN_AT) || !eloAllowsMedal(m.rated, m.eloFactor)) continue;
        const rival = opponentsOf(m).map((o) => o.userId).sort().join(',');
        const key = `${rival}|${utcDay(m.atMs)}`;
        const n = perRivalDay.get(key) ?? 0;
        if (n >= MEDAL_WINS_PER_RIVAL_PER_DAY) continue;
        perRivalDay.set(key, n + 1);
        counted.add(m.matchId);
    }
    const wins = rows.filter((m) => counted.has(m.matchId));
    const isWin = (m: MatchRow) => counted.has(m.matchId);
    const skippedWin = (m: MatchRow) => m.result >= WIN_AT && !counted.has(m.matchId);

    const progress: ModProgress = new Map();
    for (const def of allOf(modKey)) {
        progress.set(def.id, itemFor(def));
    }
    // "Living Legend" last: it counts the others, earned now or stored before (a medal is never
    // lost, so one the history no longer satisfies still counts), and never itself.
    for (const def of allOf(modKey)) {
        if (def.rule.kind !== 'collector') continue;
        const have = new Set<string>(input.held?.[modKey] ?? []);
        for (const item of progress.values()) {
            if (item.def.rule.kind === 'collector') continue;
            for (const e of item.earned) have.add(`${item.def.id}|${e.tier}`);
        }
        for (const key of [...have]) if (key.startsWith(`${def.id}|`)) have.delete(key);
        const goal = collectorGoal(modKey, def.rule.share);
        progress.set(def.id, {
            def,
            earned: have.size >= goal ? [{ tier: 0, atMs: input.nowMs }] : [],
            ...goalOf(have.size, goal),
        });
    }
    return progress;

    function itemFor(def: AchievementDef): ItemProgress {
        const r = def.rule;
        const once = (e: Earned | null): Earned[] => (e ? [e] : []);
        switch (r.kind) {
            case 'played': {
                const c = new Counter(r.goal);
                for (const m of rows) c.add(m);
                return { def, earned: once(c.at), ...goalOf(c.n, r.goal) };
            }
            case 'won': {
                const c = new Counter(r.goal);
                for (const m of wins) c.add(m);
                return { def, earned: once(c.at), ...goalOf(c.n, r.goal) };
            }
            case 'rated_played':
            case 'rated_won': {
                const c = new Counter(r.goal);
                for (const m of rows) {
                    if (m.rated !== 1 || m.ratingMode !== r.ladder) continue;
                    if (r.kind === 'rated_won' && !isWin(m)) continue;
                    c.add(m);
                }
                return { def, earned: once(c.at), ...goalOf(c.n, r.goal) };
            }
            case 'elo': {
                const required = placementRequired(r.ladder);
                if (input.gamesPlayed[r.ladder] < required) return { def, earned: [], goal: r.goal, locked: 'placement' };
                let best = 0;
                let at: Earned | null = null;
                for (const m of rows) {
                    if (m.rated !== 1 || m.ratingMode !== r.ladder || m.ratingAfter === null) continue;
                    if ((ordinals.get(m.matchId) ?? 0) < required) continue;
                    best = Math.max(best, m.ratingAfter);
                    if (at === null && m.result >= WIN_AT && m.ratingAfter >= r.goal) {
                        at = { tier: 0, atMs: m.atMs, matchId: m.matchId };
                    }
                }
                return best > 0
                    ? { def, earned: once(at), value: Math.round(best), goal: r.goal }
                    : { def, earned: once(at), goal: r.goal };
            }
            case 'graduate': {
                const required = placementRequired(r.ladder);
                const m = rows.find((x) => x.rated === 1 && x.ratingMode === r.ladder
                    && ordinals.get(x.matchId) === required);
                return { def, earned: m ? [{ tier: 0, atMs: m.atMs, matchId: m.matchId }] : [] };
            }
            case 'rated_win_streak': {
                // Competitive matches of that ladder only: a casual match in between neither adds
                // nor breaks the run, and a win the ELO or the per-rival cap discounted is skipped.
                let run = 0;
                let best = 0;
                let last: number | null = null;
                let at: Earned | null = null;
                for (const m of rows) {
                    if (m.rated !== 1 || m.ratingMode !== r.ladder || skippedWin(m)) continue;
                    if (last !== null && m.atMs - last > STREAK_IDLE_CUTOFF_MS) run = 0;
                    run = isWin(m) ? run + 1 : 0;
                    last = m.atMs;
                    best = Math.max(best, run);
                    if (at === null && run >= r.goal) at = { tier: 0, atMs: m.atMs, matchId: m.matchId };
                }
                return { def, earned: once(at), ...goalOf(best, r.goal) };
            }
            case 'collector':
                return { def, earned: [] }; // decided after every other medal, below
            case 'win_streak': {
                let run = 0;
                let best = 0;
                let last: number | null = null;
                let at: Earned | null = null;
                for (const m of rows) {
                    if (skippedWin(m)) continue;
                    if (last !== null && m.atMs - last > STREAK_IDLE_CUTOFF_MS) run = 0;
                    run = isWin(m) ? run + 1 : 0;
                    last = m.atMs;
                    best = Math.max(best, run);
                    if (at === null && run >= r.goal) at = { tier: 0, atMs: m.atMs, matchId: m.matchId };
                }
                return { def, earned: once(at), ...goalOf(best, r.goal) };
            }
            case 'phoenix': {
                let losses = 0;
                let at: Earned | null = null;
                for (const m of rows) {
                    if (skippedWin(m)) continue;
                    if (isWin(m)) {
                        if (at === null && losses >= r.losses) at = { tier: 0, atMs: m.atMs, matchId: m.matchId };
                        losses = 0;
                    } else if (m.result <= LOSS_AT) losses += 1;
                    else losses = 0;
                }
                return { def, earned: once(at) };
            }
            case 'giant_slayer': {
                const required = placementRequired('default');
                const m = wins.find((x) => {
                    if (x.rated !== 1 || x.ratingMode !== 'default' || x.ratingBefore === null) return false;
                    if ((ordinals.get(x.matchId) ?? 0) <= required) return false;
                    const opp = opponentsOf(x);
                    return opp.length === 1 && opp[0]!.ratingBefore !== null
                        && opp[0]!.ratingBefore - x.ratingBefore >= r.gap;
                });
                return { def, earned: m ? [{ tier: 0, atMs: m.atMs, matchId: m.matchId }] : [] };
            }
            case 'promotion': {
                let tier = 0;
                for (const ladder of ['default', 'team'] as const) {
                    if (positionMod[ladder] !== modKey) continue;
                    const p = input.position?.[ladder];
                    if (!p || !(p.rank >= 1) || p.size < MIN_LADDER_FOR_POSITION_MEDALS) continue;
                    tier = Math.max(tier, PROMOTION_TIERS.indexOf(ageFor(p.rank, p.size)) + 1);
                }
                const earned: Earned[] = [];
                for (let t = 1; t <= tier; t++) earned.push({ tier: t, atMs: input.nowMs });
                return { def, earned, tierNow: tier };
            }
            case 'on_top': {
                const places = r.places ?? 3;
                let top = false;
                for (const ladder of ['default', 'team'] as const) {
                    if (positionMod[ladder] !== modKey) continue;
                    const p = input.position?.[ladder];
                    if (p && p.rank >= 1 && p.rank <= places && p.size >= MIN_LADDER_FOR_POSITION_MEDALS) top = true;
                }
                return { def, earned: top ? [{ tier: 0, atMs: input.nowMs }] : [] };
            }
            case 'distinct_civ_wins': {
                const c = new DistinctCounter(r.goal);
                for (const m of wins) c.add(civKey(m.civ), m);
                return { def, earned: once(c.at), ...goalOf(c.seen.size, r.goal) };
            }
            case 'every_civ_win': {
                const list = CIV_LISTS[modKey] ?? [];
                const c = new DistinctCounter(list.length, list);
                for (const m of wins) c.add(civKey(m.civ), m);
                return { def, earned: once(c.at), ...goalOf(c.seen.size, list.length) };
            }
            case 'same_civ_wins': {
                const per = new Map<string, number>();
                let at: Earned | null = null;
                let best = 0;
                for (const m of wins) {
                    const k = civKey(m.civ);
                    if (!k) continue;
                    const n = (per.get(k) ?? 0) + 1;
                    per.set(k, n);
                    best = Math.max(best, n);
                    if (at === null && n >= r.goal) at = { tier: 0, atMs: m.atMs, matchId: m.matchId };
                }
                return { def, earned: once(at), ...goalOf(best, r.goal) };
            }
            case 'family_civ_wins': {
                const list = r.family === 'all'
                    ? [...TAD_FAMILIES.european, ...TAD_FAMILIES.native, ...TAD_FAMILIES.asian]
                    : TAD_FAMILIES[r.family];
                const c = new DistinctCounter(list.length, list);
                for (const m of wins) c.add(civKey(m.civ), m);
                return { def, earned: once(c.at), ...goalOf(c.seen.size, list.length) };
            }
            case 'matchup_win': {
                const m = wins.find((x) => {
                    const mine = civKey(x.civ);
                    if (!mine) return false;
                    return opponentsOf(x).some((o) => {
                        const theirs = civKey(o.civ);
                        if (!theirs) return false;
                        return (inSet(mine, r.mine) && inSet(theirs, r.theirs))
                            || (!!r.either && inSet(mine, r.theirs) && inSet(theirs, r.mine));
                    });
                });
                return { def, earned: m ? [{ tier: 0, atMs: m.atMs, matchId: m.matchId }] : [] };
            }
            case 'mirror_win': {
                const m = wins.find((x) => {
                    const mine = civKey(x.civ);
                    return !!mine && opponentsOf(x).some((o) => civKey(o.civ) === mine);
                });
                return { def, earned: m ? [{ tier: 0, atMs: m.atMs, matchId: m.matchId }] : [] };
            }
            case 'distinct_maps_played': {
                const c = new DistinctCounter(r.goal);
                for (const m of rows) c.add(mapKey(m.mapName), m);
                return { def, earned: once(c.at), ...goalOf(c.seen.size, r.goal) };
            }
            case 'map_list_wins': {
                const list = MAP_LISTS[r.maps];
                const goal = r.goal ?? list.length;
                const c = new DistinctCounter(goal, list);
                for (const m of wins) c.add(mapKey(m.mapName), m);
                return { def, earned: once(c.at), ...goalOf(c.seen.size, goal) };
            }
            case 'team_wins': {
                const c = new Counter(r.goal);
                for (const m of wins) if (isTeamMatch(m)) c.add(m);
                return { def, earned: once(c.at), ...goalOf(c.n, r.goal) };
            }
            case 'short_win':
            case 'long_win': {
                const m = wins.find((x) => {
                    if (x.decidedBy && DURATION_UNTRUSTED_DECIDERS.has(x.decidedBy)) return false;
                    const d = x.durationSeconds ?? 0;
                    return r.kind === 'short_win' ? d < r.maxSeconds : d > r.minSeconds;
                });
                return { def, earned: m ? [{ tier: 0, atMs: m.atMs, matchId: m.matchId }] : [] };
            }
            case 'rules_win': {
                const m = wins.find((x) => x.gameRules !== null && r.rules.includes(x.gameRules));
                return { def, earned: m ? [{ tier: 0, atMs: m.atMs, matchId: m.matchId }] : [] };
            }
            case 'distinct_opponents': {
                const c = new DistinctCounter(r.goal);
                for (const m of rows) for (const o of opponentsOf(m)) c.add(o.userId, m);
                return { def, earned: once(c.at), ...goalOf(c.seen.size, r.goal) };
            }
            case 'host': {
                const mine = input.hostedRooms.filter((e) => e.modKey === modKey);
                const hit = mine.length >= r.goal ? mine[r.goal - 1]! : null;
                return {
                    def,
                    earned: hit ? [{ tier: 0, atMs: hit.atMs }] : [],
                    ...goalOf(mine.length, r.goal),
                };
            }
            case 'distinct_days_played': {
                const c = new DistinctCounter(r.goal);
                for (const m of rows) c.add(utcDay(m.atMs), m);
                return { def, earned: once(c.at), ...goalOf(c.seen.size, r.goal) };
            }
            case 'revenge': {
                // Who won the last 1v1 against each rival; a counted win right after a loss to him.
                const lastLost = new Map<string, boolean>();
                let at: Earned | null = null;
                for (const m of rows) {
                    const opp = opponentsOf(m);
                    if (m.others.length !== 1 || opp.length !== 1) continue;
                    const rival = opp[0]!.userId;
                    if (at === null && isWin(m) && lastLost.get(rival) === true) {
                        at = { tier: 0, atMs: m.atMs, matchId: m.matchId };
                    }
                    if (m.result >= WIN_AT) lastLost.set(rival, false);
                    else if (m.result <= LOSS_AT) lastLost.set(rival, true);
                }
                return { def, earned: once(at) };
            }
            case 'formats_won': {
                const c = new DistinctCounter(r.formats.length, r.formats);
                for (const m of wins) c.add(formatOf(m), m);
                return { def, earned: once(c.at), ...goalOf(c.seen.size, r.formats.length) };
            }
            case 'quick_wins': {
                const c = new Counter(r.goal);
                for (const m of wins) if (m.quickMatch) c.add(m);
                return { def, earned: once(c.at), ...goalOf(c.n, r.goal) };
            }
            case 'civ_set_wins': {
                const c = new DistinctCounter(r.civs.length, r.civs);
                for (const m of wins) c.add(civKey(m.civ), m);
                return { def, earned: once(c.at), ...goalOf(c.seen.size, r.civs.length) };
            }
            case 'tournament_played':
            case 'finalist':
            case 'champion':
            case 'organiser': {
                const source = r.kind === 'champion' ? input.championOf
                    : r.kind === 'organiser' ? input.organiserOf
                        : r.kind === 'finalist' ? input.finalistOf ?? []
                            : input.tournamentsPlayed ?? [];
                const list = source.filter((e) => e.modKey === modKey);
                const goal = r.kind === 'champion' ? r.goal ?? 1 : 1;
                const hit = list[goal - 1];
                return {
                    def,
                    earned: hit ? [{ tier: 0, atMs: hit.atMs, tournamentId: hit.tournamentId }] : [],
                    ...goalOf(list.length, goal),
                };
            }
        }
    }
}

/** Value and goal for a counted medal; nothing for a yes/no one (goal 1). */
function goalOf(value: number, goal: number): { value?: number; goal?: number } {
    return goal > 1 ? { value: Math.min(value, goal), goal } : {};
}

/** Every medal the catalogue holds for a game, as (id, tier) pairs, for the counts. */
export function medalSlots(modKey: string): Array<{ id: string; tier: number }> {
    const out: Array<{ id: string; tier: number }> = [];
    for (const g of catalogFor(modKey)) {
        for (const i of g.items) {
            if (i.rule.kind === 'promotion') PROMOTION_TIERS.forEach((_, t) => out.push({ id: i.id, tier: t + 1 }));
            else out.push({ id: i.id, tier: 0 });
        }
    }
    return out;
}
