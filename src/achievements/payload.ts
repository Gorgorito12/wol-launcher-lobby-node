/**
 * The achievements answer the launcher draws (`GET /users/:id/achievements`). Pure.
 *
 * <p>Groups and items in catalogue order, each with what the medal asks, its progress and, once
 * earned, when. Earned means a stored, unrevoked row: a medal stays earned even when the history
 * no longer satisfies it (a voided match).</p>
 *
 * <p><b>Privacy, by leaving things out.</b> A player whose rating is private shows no medals to
 * anybody else (`hidden: 'private'`, nothing more). To others, the medals that are about a rating
 * (the ELO thresholds) never carry the player's number. `unseen` goes to the owner only.</p>
 */
import { catalogFor, defOf, medalCount, PROMOTION_TIERS } from './catalog';
import type { ModProgress } from './evaluate';
import type { EarnedRow } from './store';

export interface PayloadItem {
    id: string;
    icon: string;
    metal: string;
    name: string;
    condition: string;
    goal?: number;
    value?: number;
    ladder?: string;
    earned_at?: string;
    locked_reason?: string;
    tiers?: Array<{ tier: number; key: string; earned_at?: string }>;
    tier_reached?: number;
}

export interface PayloadGroup {
    id: string;
    enamel: number;
    name: string;
    items: PayloadItem[];
}

export interface AchievementsPayload {
    mod: string;
    total: number;
    earned?: number;
    hidden?: 'private';
    mods?: Array<{ mod: string; earned: number; total: number }>;
    groups?: PayloadGroup[];
    latest?: MedalRef[];
    unseen?: Array<MedalRef & { mod: string }>;
}

/**
 * One earned medal, with everything a launcher needs to DRAW it without knowing the catalogue:
 * its icon, its metal, the colour of its group, and its English name and condition (the launcher
 * uses its own translation when it knows the id).
 */
export interface MedalRef {
    id: string;
    tier: number;
    metal: string;
    icon: string;
    enamel: number;
    name: string;
    condition: string;
    earned_at: string;
}

/** A stored medal as a {@link MedalRef}; null when the game no longer has it. */
export function medalRef(modKey: string, id: string, tier: number, earnedAt: string): MedalRef | null {
    const found = defOf(modKey, id);
    if (!found) return null;
    return {
        id, tier, metal: found.def.metal, icon: found.def.icon, enamel: found.group.enamel,
        name: found.def.name, condition: found.def.condition, earned_at: iso(earnedAt),
    };
}

/** ISO-8601 UTC for a stored timestamp. */
function iso(ts: string): string {
    return ts.includes('T') ? ts : `${ts.replace(' ', 'T')}Z`;
}

export function buildPayload(input: {
    modKey: string;
    /** Every game he has anything in, most played first. */
    mods: readonly string[];
    progress: ModProgress | undefined;
    earned: readonly EarnedRow[];
    self: boolean;
    ratingPrivate: boolean;
}): AchievementsPayload {
    const { modKey } = input;
    const total = medalCount(modKey);
    if (input.ratingPrivate && !input.self) return { mod: modKey, total, hidden: 'private' };

    const mine = input.earned.filter((r) => r.mod_key === modKey);
    const earnedOf = (id: string, tier: number) => mine.find((r) => r.achievement_id === id && r.tier === tier);
    // Only medals the catalogue still has count, so a removed medal cannot push "41 of 40".
    const known = new Set<string>();
    for (const g of catalogFor(modKey)) for (const i of g.items) known.add(i.id);
    const countIn = (k: string) => input.earned.filter((r) => r.mod_key === k
        && catalogFor(k).some((g) => g.items.some((i) => i.id === r.achievement_id))).length;

    const groups: PayloadGroup[] = catalogFor(modKey).map((g) => ({
        id: g.id,
        enamel: g.enamel,
        name: g.name,
        items: g.items.map((def) => {
            const p = input.progress?.get(def.id);
            const item: PayloadItem = {
                id: def.id, icon: def.icon, metal: def.metal, name: def.name, condition: def.condition,
            };
            const ladderItem = def.rule.kind === 'elo';
            if (def.rule.kind === 'elo') item.ladder = def.rule.ladder;
            if (def.rule.kind === 'promotion') {
                item.tiers = PROMOTION_TIERS.map((key, i) => {
                    const row = earnedOf(def.id, i + 1);
                    return row ? { tier: i + 1, key, earned_at: iso(row.earned_at) } : { tier: i + 1, key };
                });
                item.tier_reached = item.tiers.filter((t) => t.earned_at).length;
                return item;
            }
            if (p?.goal !== undefined) item.goal = p.goal;
            if (p?.value !== undefined && (input.self || !ladderItem)) item.value = p.value;
            if (p?.locked) item.locked_reason = p.locked;
            const row = earnedOf(def.id, 0);
            if (row) item.earned_at = iso(row.earned_at);
            return item;
        }),
    }));

    const latest = [...mine]
        .filter((r) => known.has(r.achievement_id))
        .sort((x, y) => (x.earned_at < y.earned_at ? 1 : x.earned_at > y.earned_at ? -1 : 0))
        .slice(0, 3)
        .map((r) => medalRef(modKey, r.achievement_id, r.tier, r.earned_at)!)
        .filter(Boolean);

    const mods = [...new Set([...input.mods, ...input.earned.map((r) => r.mod_key)])]
        .filter(Boolean)
        .map((k) => ({ mod: k, earned: countIn(k), total: medalCount(k) }));

    const out: AchievementsPayload = {
        mod: modKey, total, earned: countIn(modKey), mods, groups, latest,
    };
    if (input.self) {
        out.unseen = input.earned
            .filter((r) => r.seen_at === null)
            .flatMap((r) => {
                const ref = medalRef(r.mod_key, r.achievement_id, r.tier, r.earned_at);
                return ref ? [{ ...ref, mod: r.mod_key }] : [];
            });
    }
    return out;
}
