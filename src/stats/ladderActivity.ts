/**
 * The public table lists ACTIVE players only (2026-11-18). A placed player with no rated match
 * on a ladder in `days` days leaves that ladder's table — no place, no badge, exactly like a
 * private rating: absent, never the lowest badge — until his next rated match puts him back. He
 * keeps his rating and sees it; everybody else still sees his number in rooms and history.
 *
 * <p>Read through {@link activityBinds}, which `LADDER_WHERE` and the placement list share, so a
 * place, the size of the table and the list itself cannot disagree about who is on it.</p>
 *
 * <p><b>For a small community</b> the days are settings (`LADDER_INACTIVE_DAYS`, and
 * `LADDER_INACTIVE_DAYS_TEAM` for the thinner team ladder), and `LADDER_HIDE_INACTIVE=false`
 * brings back the label-only behaviour at once. Deliberately not "never hide under N players":
 * crossing N would bring everybody back at the same moment and move every badge.</p>
 */
export interface LadderActivity {
    hide: boolean;
    days: number;
    daysTeam: number;
}

const DEFAULTS: LadderActivity = { hide: true, days: 30, daysTeam: 30 };
let current: LadderActivity = { ...DEFAULTS };

/** Called once at startup from the config (src/index.ts). */
export function configureLadderActivity(a: Partial<LadderActivity>): void {
    current = {
        hide: a.hide ?? DEFAULTS.hide,
        days: Math.max(1, Math.floor(a.days ?? DEFAULTS.days)),
        daysTeam: Math.max(1, Math.floor(a.daysTeam ?? DEFAULTS.daysTeam)),
    };
}

export function ladderActivity(): LadderActivity {
    return current;
}

/** Days without a rated match after which a placed player leaves this ladder's table. */
export function inactiveDays(mode: 'default' | 'team'): number {
    return mode === 'team' ? current.daysTeam : current.days;
}

/**
 * The clause every ranked list appends, and its two binds: hiding on/off, then the SQLite
 * modifier. A row with no `last_rated_at` (older data) is judged by `updated_at`.
 */
export const ACTIVITY_CLAUSE =
    `(? = 0 OR COALESCE(e.last_rated_at, e.updated_at) >= datetime('now', ?))`;

export function activityBinds(mode: 'default' | 'team'): [number, string] {
    return [current.hide ? 1 : 0, `-${inactiveDays(mode)} days`];
}

/** Whether a player last rated at `lastMs` is off the table now (false when hiding is off). */
export function isOffTable(lastMs: number | null, nowMs: number, mode: 'default' | 'team'): boolean {
    if (!current.hide || lastMs === null || !Number.isFinite(lastMs)) return false;
    return nowMs - lastMs > inactiveDays(mode) * 24 * 60 * 60 * 1000;
}

/** Tests only. */
export function resetLadderActivityForTests(): void {
    current = { ...DEFAULTS };
}
