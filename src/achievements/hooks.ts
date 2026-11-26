/**
 * When medals are evaluated: a second after a match of the player is stored or changes, and when
 * a tournament he won or organised finishes.
 *
 * <p><b>Never inside the report.</b> Every Db call is synchronous, so evaluating in the request's
 * own chain would delay the report's answer by the whole evaluation; and the founding path starts
 * a ladder replay right after announcing a match, which an evaluation running alongside could read
 * half-built — handing out an age or a podium the table never really held. So the players are
 * collected and evaluated together from a timer, like `matches_changed` (one report, its late
 * rating and a civilization filled in are one evaluation, not three).</p>
 *
 * <p>Best-effort and silent: an error evaluating one player is logged by nobody and costs that
 * player nothing but a delay — the next match, or opening his profile, evaluates again.</p>
 */
import type { AppContext } from '../context';
import { countEarned, evaluateAndAward, type Awarded } from './store';
import { medalCount } from './catalog';
import { medalRef, type MedalRef } from './payload';

export type Schedule = (fn: () => void, ms: number) => unknown;

/** The frame a launcher that said it speaks `achievements` receives for its new medals. */
export interface AchievementUnlockedFrame {
    type: 'achievement_unlocked';
    mod: string;
    items: MedalRef[];
    earned: number;
    total: number;
}

export class AchievementsBatcher {
    private readonly users = new Set<string>();
    private pending = false;
    private running: Promise<void> = Promise.resolve();

    private readonly run: (userIds: string[]) => Promise<void>;
    private readonly delayMs: number;
    private readonly schedule: Schedule;

    constructor(
        run: (userIds: string[]) => Promise<void>,
        delayMs = 1000,
        schedule: Schedule = (fn, ms) => setTimeout(fn, ms),
    ) {
        this.run = run;
        this.delayMs = delayMs;
        this.schedule = schedule;
    }

    /** Evaluate these players soon. A burst joins the one flush already scheduled. */
    add(userIds: readonly string[]): void {
        for (const id of userIds) if (id) this.users.add(id);
        if (this.pending || this.users.size === 0) return;
        this.pending = true;
        this.schedule(() => { void this.flush(); }, this.delayMs);
    }

    /** Evaluate what was collected, one flush after the other. Never throws. */
    flush(): Promise<void> {
        this.pending = false;
        if (this.users.size === 0) return this.running;
        const ids = [...this.users];
        this.users.clear();
        this.running = this.running.then(() => this.run(ids)).catch(() => { /* best-effort */ });
        return this.running;
    }
}

/** Group what one evaluation handed out into the frames to push (unseen medals only). */
export function framesFor(awarded: readonly Awarded[], earnedByMod: ReadonlyMap<string, number>): AchievementUnlockedFrame[] {
    const byMod = new Map<string, Awarded[]>();
    for (const a of awarded) {
        if (a.seen) continue;
        const list = byMod.get(a.modKey) ?? [];
        list.push(a);
        byMod.set(a.modKey, list);
    }
    return [...byMod.entries()].map(([mod, list]) => ({
        type: 'achievement_unlocked',
        mod,
        items: list.flatMap((x) => {
            const ref = medalRef(mod, x.id, x.tier, x.earnedAt);
            return ref ? [ref] : [];
        }),
        earned: earnedByMod.get(mod) ?? list.length,
        total: medalCount(mod),
    }));
}

/** Evaluate these players and tell each launcher what it has just earned. */
export async function evaluateAndPush(ctx: AppContext, userIds: readonly string[]): Promise<void> {
    for (const userId of userIds) {
        try {
            const { awarded } = await evaluateAndAward(ctx, userId);
            if (!awarded.some((a) => !a.seen)) continue;
            const counts = await countEarned(ctx.db, userId);
            for (const frame of framesFor(awarded, counts)) {
                ctx.globalChat.sendToFeature(userId, 'achievements', frame);
            }
        } catch { /* best-effort: the next evaluation catches up */ }
    }
}

let batcher: AchievementsBatcher | null = null;

function batcherFor(ctx: AppContext): AchievementsBatcher {
    batcher ??= new AchievementsBatcher((ids) => evaluateAndPush(ctx, ids));
    return batcher;
}

/** A match was stored or changed: evaluate its players and the player who opened its room. */
export async function noteMatchChanged(ctx: AppContext, matchId: string): Promise<void> {
    try {
        const rows = await ctx.db.prepare(
            `SELECT p.user_id FROM match_participants p WHERE p.match_id = ?
             UNION
             SELECT COALESCE(l.created_by, l.host_user_id) FROM matches m
               JOIN lobbies l ON l.id = m.lobby_id WHERE m.id = ?`,
        ).bind(matchId, matchId).all<{ user_id: string | null }>();
        batcherFor(ctx).add((rows.results ?? []).map((r) => r.user_id ?? '').filter(Boolean));
    } catch { /* best-effort */ }
}

/** A tournament finished: evaluate its champion's players and its organiser. */
export async function noteTournamentFinished(ctx: AppContext, tournamentId: string): Promise<void> {
    try {
        const rows = await ctx.db.prepare(
            `SELECT em.user_id FROM tournaments t
               JOIN tournament_entrant_members em ON em.entrant_id = t.winner_entrant_id
              WHERE t.id = ?
             UNION
             SELECT owner_user_id FROM tournaments WHERE id = ?`,
        ).bind(tournamentId, tournamentId).all<{ user_id: string | null }>();
        batcherFor(ctx).add((rows.results ?? []).map((r) => r.user_id ?? '').filter(Boolean));
    } catch { /* best-effort */ }
}

/** For tests: drop the process-wide batcher. */
export function resetAchievementsBatcherForTests(): void {
    batcher = null;
}
