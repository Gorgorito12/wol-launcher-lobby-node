/**
 * The badge a player shows beside their name where no match decides it (design handoff 51c).
 *
 * <p>Three values on the wire — `highest | 1v1 | team` — and deliberately NOT the ladder's own
 * `'default'` for 1v1: beside `highest`, a value called `default` reads as "the default
 * preference", which is exactly the misreading that would make somebody pick it.</p>
 *
 * <p>The DECISION (which badge actually shows, given a room and two ages) is the launcher's,
 * because it needs the ladder SIZES the launcher already has and the room format it already
 * derives. The server only stores the preference and refuses a Teams choice nobody could wear.</p>
 */
import type { AppContext } from '../context';
import { currentSeason } from '../elo/seasons';
import { LADDER_WHERE, MIN_DECIDED } from '../stats/rest';

export const BADGE_MODES = ['highest', '1v1', 'team'] as const;
export type BadgeMode = (typeof BADGE_MODES)[number];

/**
 * Strict: what the endpoint accepts. Anything else is a 400, never a silent fallback — a
 * client that sends a value it believes is valid should learn it is not.
 */
export function parseBadgeMode(raw: unknown): BadgeMode | null {
    return typeof raw === 'string' && (BADGE_MODES as readonly string[]).includes(raw)
        ? (raw as BadgeMode)
        : null;
}

/**
 * Lenient: what every READ uses. A value the code does not know — a hand-edited row, a value a
 * later build adds and an older one reads — becomes `highest`, the default, rather than being
 * forwarded for a launcher to choke on.
 */
export function normalizeBadgeMode(raw: unknown): BadgeMode {
    return parseBadgeMode(raw) ?? 'highest';
}

/**
 * Whether a player has a place on the TEAM ladder — the condition for choosing the Teams badge.
 *
 * <p>Built on {@link LADDER_WHERE}, never restating it: "may wear the team badge" and "is on the
 * team ladder" must be the SAME question, or the selector would unlock a badge the ladder then
 * draws as Discovery (or lock one it draws in colour). A team match only rates once both sides'
 * readings agree, so this is exactly "has a decided team match" while MIN_DECIDED is 1.</p>
 *
 * <p>Binds: `'team'`, MIN_DECIDED, the season, the user id. The season is the RUNNING one: a place
 * on last season's team ladder does not unlock this season's team badge, exactly as the badge
 * itself reads Discovery until the first team match of the season.</p>
 *
 * <p><b>A function, not a constant, and that is load-bearing:</b> `stats/rest` → `matches/rest`
 * → this module → `stats/rest` is an import cycle, so at the moment this module is evaluated
 * {@link LADDER_WHERE} may not exist yet — a module-level template string threw "cannot access
 * before initialization" and took nine test files down with it. Built on call, it reads the
 * constant long after every module has finished loading.</p>
 */
export function teamBadgeEligibleSql(): string {
    return `SELECT 1 AS ok
         FROM season_ratings e
         JOIN users u ON u.id = e.user_id
         ${LADDER_WHERE}
           AND e.user_id = ?
         LIMIT 1`;
}

export async function hasTeamPlace(ctx: AppContext, userId: string): Promise<boolean> {
    const row = await ctx.db.prepare(teamBadgeEligibleSql())
        .bind('team', MIN_DECIDED, currentSeason(Date.now()), userId)
        .first<{ ok: number }>();
    return !!row;
}

/**
 * The stored preference of several players in ONE query. Never throws: on an error the map is
 * empty and the field is omitted — the launcher then falls back to Highest, which is what an
 * older server meant all along. Same contract as `ladderRanks`.
 */
export async function badgeModes(ctx: AppContext, userIds: string[]): Promise<Map<string, BadgeMode>> {
    const unique = [...new Set(userIds.filter(Boolean))];
    const out = new Map<string, BadgeMode>();
    if (unique.length === 0) return out;
    try {
        const ids = unique.map(() => '?').join(', ');
        const rows = await ctx.db.prepare(
            `SELECT id, badge_mode FROM users WHERE id IN (${ids})`,
        ).bind(...unique).all<{ id: string; badge_mode: string | null }>();
        for (const r of rows.results ?? []) out.set(r.id, normalizeBadgeMode(r.badge_mode));
    } catch {
        out.clear();
    }
    return out;
}
