/**
 * When a tournament stops counting as alive.
 *
 * ---------------------------------------------------------------------------
 * Why this is evaluated on READ and not by a scheduler
 * ---------------------------------------------------------------------------
 * This server has no periodic timer and this feature must not be the one that adds the
 * first. The only recurring thing in the process is the KV expiry sweep; everything else
 * — the presence debounce, the Discord edit debounce, the orphan-lobby sweep — is a
 * one-shot `setTimeout`.
 *
 * So staleness is a PREDICATE, not an event. The public list filters on it, and both
 * creation caps ignore rows that match it. A forgotten tournament therefore costs nothing
 * the moment it goes quiet, whether or not anything has marked it. The startup sweep that
 * flips it to `abandoned` is tidiness — so `tournament:list` and the database agree with
 * what players already see — and never correctness.
 *
 * That is why `isStale` and `staleWhereClause` both live here and are pinned against each
 * other by a test: two copies of a rule is how they come to disagree, and these two are in
 * different languages.
 *
 * ---------------------------------------------------------------------------
 * Why archiving is not "deciding a match automatically"
 * ---------------------------------------------------------------------------
 * The maintainer's rule is that nothing automatic decides a game: no deadlines, no
 * auto-forfeits, no advancing on a clock. Archiving does none of that. `abandoned` crowns
 * nobody, moves no rating, and touches no row in `tournament_matches`. It only stops a
 * dead tournament occupying a slot in the list and in the two creation caps.
 *
 * Pure and side-effect free — the callers do the I/O.
 */
import { sqliteTimestampToMs } from '../lib/time';

/** Every state a tournament can be in. */
export type TournamentStatus =
    | 'draft'
    | 'registration'
    | 'ready'
    | 'running'
    | 'finished'
    | 'cancelled'
    | 'abandoned';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A tournament created and never opened for registration.
 *
 * Shorter than everything else because nobody has ever seen it: it was never listed for
 * players, so archiving one costs no one anything. A week is long enough to cover
 * "I set it up on Monday and announced it on Friday".
 */
export const DRAFT_STALE_DAYS = 7;

/**
 * Anything else that is still live: open for registration, seeded, or mid-bracket.
 *
 * A month, because a real tournament genuinely can pause — people go on holiday, a round
 * waits on one player — and thirty days of complete silence is past that. It counts from
 * `last_activity_at`, so a single registration or one reported match resets it.
 */
export const LIVE_STALE_DAYS = 30;

/** The statuses that can never go stale: they are already over, and history is cheap. */
export const TERMINAL_STATUSES: readonly TournamentStatus[] = ['finished', 'cancelled', 'abandoned'];

export function isTerminal(status: TournamentStatus): boolean {
    return TERMINAL_STATUSES.includes(status);
}

export interface StalenessInput {
    status: TournamentStatus;
    /** SQLite `datetime('now')` text. */
    createdAt: string;
    /** SQLite `datetime('now')` text, stamped by every write that means somebody cares. */
    lastActivityAt: string | null;
}

/**
 * Whether this tournament should stop appearing and stop counting against the caps.
 *
 * A missing or unreadable `last_activity_at` falls back to `created_at` rather than to
 * "now": treating an unparseable timestamp as fresh would make a row immortal, which is
 * the exact failure this whole module exists to prevent.
 */
export function isStale(t: StalenessInput, nowMs: number): boolean {
    if (isTerminal(t.status)) return false;

    const days = t.status === 'draft' ? DRAFT_STALE_DAYS : LIVE_STALE_DAYS;
    const stamp = t.status === 'draft'
        ? sqliteTimestampToMs(t.createdAt)
        : sqliteTimestampToMs(t.lastActivityAt) ?? sqliteTimestampToMs(t.createdAt);

    // Nothing readable to age against. Treat it as stale rather than as new — an
    // undateable row is exactly the kind that would otherwise sit there for ever.
    if (stamp === null) return true;

    return nowMs - stamp > days * DAY_MS;
}

/**
 * The same rule as a SQL fragment, for the list query and for both caps.
 *
 * Written against `julianday('now')` rather than against a bound timestamp so the caller
 * cannot accidentally pass a clock that disagrees with the one the rows were written
 * with — every `datetime('now')` in this database comes from SQLite itself.
 *
 * Returns a condition that is TRUE for a tournament that is still alive, because that is
 * the shape every caller wants: `WHERE ... AND ${aliveWhereClause('t')}`.
 */
export function aliveWhereClause(alias = ''): string {
    const col = (name: string) => (alias ? `${alias}.${name}` : name);
    return `(
        ${col('status')} IN ('finished','cancelled','abandoned')
        OR (${col('status')} = 'draft'
            AND julianday('now') - julianday(${col('created_at')}) <= ${DRAFT_STALE_DAYS})
        OR (${col('status')} <> 'draft'
            AND julianday('now') - julianday(COALESCE(${col('last_activity_at')}, ${col('created_at')}))
                <= ${LIVE_STALE_DAYS})
    )`;
}

/**
 * The complement: rows the startup sweep should flip to `abandoned`.
 *
 * Terminal rows are excluded here rather than left to the caller, because a sweep that
 * re-archived a cancelled tournament would stamp a new `abandoned_at` over a real
 * `cancelled_at` and lose why it ended.
 */
export function staleWhereClause(alias = ''): string {
    const col = (name: string) => (alias ? `${alias}.${name}` : name);
    return `(
        ${col('status')} NOT IN ('finished','cancelled','abandoned')
        AND (
            (${col('status')} = 'draft'
                AND julianday('now') - julianday(${col('created_at')}) > ${DRAFT_STALE_DAYS})
            OR (${col('status')} <> 'draft'
                AND julianday('now') - julianday(COALESCE(${col('last_activity_at')}, ${col('created_at')}))
                    > ${LIVE_STALE_DAYS})
        )
    )`;
}

/**
 * Statuses whose rows a user is limited to owning a couple of at a time.
 *
 * Terminal ones are free: somebody who has run twenty tournaments is exactly the person
 * you want running a twenty-first. Only the live ones cost a slot, and stale ones are
 * excluded by `aliveWhereClause` on top of this.
 */
export const CAPPED_STATUSES: readonly TournamentStatus[] =
    ['draft', 'registration', 'ready', 'running'];

// ---------------------------------------------------------------- who sees an ended tournament

/**
 * How long an ended tournament stays where people see it, and what happens after
 * (2026-11-11, the maintainer's "limpieza inteligente").
 *
 * | Tournament                                   | Who sees it                 | After            |
 * |----------------------------------------------|-----------------------------|------------------|
 * | draft                                        | its owner                   | 7 days: deleted  |
 * | cancelled / abandoned, NO game played        | its owner, 7 days           | deleted          |
 * | cancelled / abandoned, games played          | everybody, 7 days           | kept, unlisted   |
 * | finished                                     | everybody, 30 days          | only who took part |
 *
 * A tournament with a played game is NEVER deleted: its games and the rating they moved are
 * history. What "played" means is {@link playedSql}.
 *
 * Like staleness, all of this is evaluated on READ. The startup sweep deletes what is due,
 * which is tidiness: between restarts the list already hides it.
 */
export const ENDED_PUBLIC_DAYS = 7;
export const UNPLAYED_KEEP_DAYS = 7;
export const FINISHED_PUBLIC_DAYS = 30;

/**
 * True when a game of this tournament was played: a bracket slot decided by a game, or a game
 * reported from one of its rooms that has not moved the bracket (a team result waiting for its
 * confirmation, a recording that did not match). Either one is a game somebody played and the
 * ladder may have rated, so either one keeps the tournament.
 */
export function playedSql(alias = ''): string {
    const id = alias ? `${alias}.id` : 'id';
    return `(
        EXISTS (SELECT 1 FROM tournament_matches tmp
                 WHERE tmp.tournament_id = ${id} AND tmp.match_id IS NOT NULL)
        OR EXISTS (SELECT 1 FROM matches mp
                     JOIN tournament_matches tmq ON tmq.id = mp.tournament_match_id
                    WHERE tmq.tournament_id = ${id})
    )`;
}

/** When the tournament ended, for an ended one: cancelled, abandoned, else its last activity. */
function endedAtSql(alias = ''): string {
    const col = (name: string) => (alias ? `${alias}.${name}` : name);
    return `COALESCE(${col('cancelled_at')}, ${col('abandoned_at')}, ${col('last_activity_at')})`;
}

/**
 * The public list's rule: not a draft, alive, and an ended tournament only while its window
 * lasts. Embeds {@link aliveWhereClause} verbatim, so the list and the creation caps cannot
 * disagree about what is alive.
 */
export function publicWhereClause(alias = ''): string {
    const col = (name: string) => (alias ? `${alias}.${name}` : name);
    return `${col('status')} <> 'draft' AND ${aliveWhereClause(alias)}
        AND NOT (${col('status')} IN ('cancelled','abandoned')
                 AND (NOT ${playedSql(alias)}
                      OR julianday('now') - julianday(${endedAtSql(alias)}) > ${ENDED_PUBLIC_DAYS}))
        AND NOT (${col('status')} = 'finished'
                 AND julianday('now') - julianday(COALESCE(${col('finished_at')}, ${col('last_activity_at')}))
                     > ${FINISHED_PUBLIC_DAYS})`;
}

/**
 * Rows the startup sweep deletes: a stale draft, and a cancelled or abandoned tournament with
 * no game played whose week is over. Never one with a game played.
 */
export function dueForDeletionWhereClause(alias = ''): string {
    const col = (name: string) => (alias ? `${alias}.${name}` : name);
    return `(
        (${col('status')} = 'draft'
            AND julianday('now') - julianday(${col('created_at')}) > ${DRAFT_STALE_DAYS})
        OR (${col('status')} IN ('cancelled','abandoned')
            AND julianday('now') - julianday(${endedAtSql(alias)}) > ${UNPLAYED_KEEP_DAYS})
    ) AND NOT ${playedSql(alias)}`;
}

/** The statuses an owner may delete from the launcher — and then only with no game played. */
export const DELETABLE_STATUSES: readonly TournamentStatus[] = ['draft', 'cancelled', 'abandoned'];

export interface VisibilityInput {
    status: TournamentStatus;
    createdAt: string;
    lastActivityAt: string | null;
    /** cancelled_at ?? abandoned_at, for an ended one. */
    endedAt: string | null;
    finishedAt: string | null;
    played: boolean;
}

/** The JS twin of {@link publicWhereClause}, for tests and the CLI. */
export function isPubliclyListed(t: VisibilityInput, nowMs: number): boolean {
    if (t.status === 'draft') return false;
    if (isStale(t, nowMs)) return false;
    const age = (stamp: string | null) => {
        const ms = sqliteTimestampToMs(stamp) ?? sqliteTimestampToMs(t.lastActivityAt);
        return ms === null ? Infinity : nowMs - ms;
    };
    if (t.status === 'cancelled' || t.status === 'abandoned') {
        return t.played && age(t.endedAt) <= ENDED_PUBLIC_DAYS * DAY_MS;
    }
    if (t.status === 'finished') return age(t.finishedAt) <= FINISHED_PUBLIC_DAYS * DAY_MS;
    return true;
}

/** Whether its owner may delete it now. */
export function mayDelete(t: { status: TournamentStatus; played: boolean }): boolean {
    return DELETABLE_STATUSES.includes(t.status) && !t.played;
}
