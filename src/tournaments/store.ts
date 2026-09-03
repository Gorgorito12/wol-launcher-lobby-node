/**
 * Every SQL statement the tournament feature runs, in one file.
 *
 * The routes, the advancement hook and `scripts/admin.ts` all read and write the same
 * five tables. Left to themselves each would grow its own copy of "load the bracket" and
 * "stamp the activity", and the copies would drift — which is the same argument that put
 * `isBanned` in one place and `sqliteTimestampToMs` in another after two callers appeared.
 *
 * Two rules this file exists to hold:
 *
 *  - **Capacity is CLAIMED, never checked.** `claimSeat` is a conditional UPDATE whose
 *    `changes` count is the answer. A read-then-write cannot work here: every handler
 *    awaits between the two, and an await is where two registrations interleave. The seat
 *    cap on lobbies has exactly that bug — it reads `current_players`, awaits three times,
 *    then inserts — and two players can take the last seat of a room.
 *  - **Activity is stamped by every write that means somebody still cares.** Miss one and
 *    a busy tournament is archived out from under its players.
 */
import type { Db } from '../db';
import type { BracketMatch, BracketUpdate, Slot } from './bracket';
import type { EntrantStatus, TournamentFormat, TeamSource } from './entrants';
import { aliveWhereClause, CAPPED_STATUSES, type TournamentStatus } from './lifecycle';

// ---------------------------------------------------------------- row shapes

export interface TournamentRow {
    id: string;
    name: string;
    mod_id: string;
    owner_user_id: string;
    format: TournamentFormat;
    team_source: TeamSource;
    entry_mode: 'open' | 'approval';
    status: TournamentStatus;
    best_of: number;
    capacity: number;
    confirmed_count: number;
    bracket_size: number | null;
    winner_entrant_id: string | null;
    featured: number;
    created_at: string;
    last_activity_at: string;
    registration_opened_at: string | null;
    started_at: string | null;
    finished_at: string | null;
    cancelled_at: string | null;
    abandoned_at: string | null;
}

export interface EntrantRow {
    id: string;
    tournament_id: string;
    kind: 'solo' | 'team';
    team_id: string | null;
    display_name: string;
    captain_user_id: string;
    seed: number | null;
    status: EntrantStatus;
    registered_at: string;
}

export interface TournamentMatchRow {
    id: string;
    tournament_id: string;
    round: number;
    position: number;
    entrant1_id: string | null;
    entrant2_id: string | null;
    winner_entrant_id: string | null;
    status: BracketMatch['status'];
    outcome: BracketMatch['outcome'];
    match_id: string | null;
    decided_by: string | null;
    decided_at: string | null;
    next_match_id: string | null;
    next_slot: Slot | null;
}

// ---------------------------------------------------------------- reads

export async function getTournament(db: Db, id: string): Promise<TournamentRow | undefined> {
    return db.prepare(`SELECT * FROM tournaments WHERE id = ?`).bind(id).first<TournamentRow>();
}

/**
 * How many live tournaments this user owns, ignoring stale ones.
 *
 * The stale exclusion is the point: a tournament somebody set up and forgot must not lock
 * them out of making another one, and it must stop counting the moment it goes quiet
 * rather than when a sweep happens to notice.
 */
export async function countOwnedLive(db: Db, userId: string): Promise<number> {
    const statuses = CAPPED_STATUSES.map((s) => `'${s}'`).join(',');
    const row = await db.prepare(
        `SELECT COUNT(*) AS n FROM tournaments t
          WHERE t.owner_user_id = ?
            AND t.status IN (${statuses})
            AND ${aliveWhereClause('t')}`,
    ).bind(userId).first<{ n: number }>();
    return row?.n ?? 0;
}

/** The same count across the whole server, for the global cap. */
export async function countAllLive(db: Db): Promise<number> {
    const statuses = CAPPED_STATUSES.map((s) => `'${s}'`).join(',');
    const row = await db.prepare(
        `SELECT COUNT(*) AS n FROM tournaments t
          WHERE t.status IN (${statuses}) AND ${aliveWhereClause('t')}`,
    ).bind().first<{ n: number }>();
    return row?.n ?? 0;
}

export async function listEntrants(db: Db, tournamentId: string): Promise<EntrantRow[]> {
    const r = await db.prepare(
        `SELECT * FROM tournament_entrants
          WHERE tournament_id = ?
          ORDER BY COALESCE(seed, 9999), registered_at`,
    ).bind(tournamentId).all<EntrantRow>();
    return r.results ?? [];
}

/** Frozen rosters for a whole tournament, as entrant id to user ids. */
export async function loadRosters(
    db: Db,
    tournamentId: string,
): Promise<Map<string, string[]>> {
    const r = await db.prepare(
        `SELECT m.entrant_id, m.user_id
           FROM tournament_entrant_members m
           JOIN tournament_entrants e ON e.id = m.entrant_id
          WHERE e.tournament_id = ?`,
    ).bind(tournamentId).all<{ entrant_id: string; user_id: string }>();

    const out = new Map<string, string[]>();
    for (const row of r.results ?? []) {
        const list = out.get(row.entrant_id);
        if (list) list.push(row.user_id);
        else out.set(row.entrant_id, [row.user_id]);
    }
    return out;
}

/**
 * Everyone already spoken for in this tournament.
 *
 * Only entrants that still occupy a place count: a withdrawn or rejected one frees its
 * players, which is what makes re-registering after a mistake possible.
 */
export async function playersAlreadyEntered(
    db: Db,
    tournamentId: string,
): Promise<Set<string>> {
    const r = await db.prepare(
        `SELECT m.user_id
           FROM tournament_entrant_members m
           JOIN tournament_entrants e ON e.id = m.entrant_id
          WHERE e.tournament_id = ?
            AND e.status IN ('pending','confirmed','waitlist')`,
    ).bind(tournamentId).all<{ user_id: string }>();
    return new Set((r.results ?? []).map((x) => x.user_id));
}

export async function loadBracket(db: Db, tournamentId: string): Promise<BracketMatch[]> {
    const r = await db.prepare(
        `SELECT * FROM tournament_matches WHERE tournament_id = ? ORDER BY round, position`,
    ).bind(tournamentId).all<TournamentMatchRow>();
    return (r.results ?? []).map(toBracketMatch);
}

export function toBracketMatch(row: TournamentMatchRow): BracketMatch {
    return {
        id: row.id,
        round: row.round,
        position: row.position,
        entrant1Id: row.entrant1_id,
        entrant2Id: row.entrant2_id,
        winnerEntrantId: row.winner_entrant_id,
        status: row.status,
        outcome: row.outcome,
        nextMatchId: row.next_match_id,
        nextSlot: row.next_slot,
    };
}

/**
 * The bracket slot a finished game belongs to, read off the ROOM.
 *
 * Never from the report body. Same rule as `lobbies.competitive`: the server decided this
 * before the game, so the client cannot claim that whatever it just played was a
 * tournament match.
 */
export async function findTournamentMatchForLobby(
    db: Db,
    matchId: string,
): Promise<{ tournamentMatchId: string; tournamentId: string } | null> {
    const row = await db.prepare(
        `SELECT tm.id AS tournament_match_id, tm.tournament_id
           FROM matches m
           JOIN lobbies l  ON l.id = m.lobby_id
           JOIN tournament_matches tm ON tm.id = l.tournament_match_id
          WHERE m.id = ?`,
    ).bind(matchId).first<{ tournament_match_id: string; tournament_id: string }>();
    return row ? { tournamentMatchId: row.tournament_match_id, tournamentId: row.tournament_id } : null;
}

/** The room currently bound to a bracket slot, if one is still open. */
export async function activeLobbyForMatch(
    db: Db,
    tournamentMatchId: string,
): Promise<{ id: string; host_user_id: string; status: string; title: string } | undefined> {
    return db.prepare(
        `SELECT id, host_user_id, status, title FROM lobbies
          WHERE tournament_match_id = ? AND status IN ('open','locked','in_game')
          ORDER BY rowid DESC LIMIT 1`,
    ).bind(tournamentMatchId).first();
}

/**
 * Whether this user is on either side of a bracket slot, by the FROZEN roster.
 *
 * Frozen and not live: a saved team can drop a player the day after entering, and the
 * person who was registered is the person who plays. Reading `team_members` here instead
 * would let a roster change mid-tournament lock somebody out of their own match.
 *
 * Used by the join guard, so it must not care what the entrant's STATUS is: somebody
 * disqualified mid-match still belongs in the room they are already sitting in, and
 * whether the match counts is the bracket's decision, not the door's.
 */
export async function isEntrantMember(
    db: Db,
    tournamentMatchId: string,
    userId: string,
): Promise<boolean> {
    const row = await db.prepare(
        `SELECT 1 AS ok
           FROM tournament_matches tm
           JOIN tournament_entrant_members m
             ON m.entrant_id = tm.entrant1_id OR m.entrant_id = tm.entrant2_id
          WHERE tm.id = ? AND m.user_id = ?
          LIMIT 1`,
    ).bind(tournamentMatchId, userId).first<{ ok: number }>();
    return !!row;
}

/** Every open room bound to any slot of this tournament — what cancelling has to close. */
export async function openLobbiesForTournament(db: Db, tournamentId: string): Promise<string[]> {
    const r = await db.prepare(
        `SELECT l.id FROM lobbies l
           JOIN tournament_matches tm ON tm.id = l.tournament_match_id
          WHERE tm.tournament_id = ? AND l.status IN ('open','locked','in_game')`,
    ).bind(tournamentId).all<{ id: string }>();
    return (r.results ?? []).map((x) => x.id);
}

/**
 * The condition every public listing and both creation caps share.
 *
 * Exported and pinned by a test the way `LADDER_WHERE` is, because there is no database
 * harness in this repo and this string is the only place the "which tournaments exist"
 * rule is written down for SQL. If it and `isStale` drift, the list hides what the cap
 * still counts, and the symptom is somebody told they own two tournaments while seeing
 * one.
 *
 * Drafts are excluded here on purpose: a draft is invisible until its owner opens
 * registration. The owner's OWN drafts come back through `listOwnDrafts`, because
 * otherwise the person who just created one could not find it again.
 */
export const TOURNAMENT_LIST_WHERE = `WHERE t.status <> 'draft' AND ${aliveWhereClause('t')}`;

export interface TournamentListRow {
    id: string;
    name: string;
    mod_id: string;
    owner_user_id: string;
    format: TournamentFormat;
    team_source: TeamSource;
    entry_mode: 'open' | 'approval';
    status: TournamentStatus;
    capacity: number;
    confirmed_count: number;
    entrant_count: number;
    created_at: string;
    last_activity_at: string;
}

const LIST_COLUMNS = `
    t.id, t.name, t.mod_id, t.owner_user_id, t.format, t.team_source, t.entry_mode,
    t.status, t.capacity, t.confirmed_count, t.created_at, t.last_activity_at,
    (SELECT COUNT(*) FROM tournament_entrants e
      WHERE e.tournament_id = t.id
        AND e.status IN ('pending','confirmed','waitlist')) AS entrant_count`;

/** The public list: newest activity first, drafts excluded, stale ones already gone. */
export async function listTournaments(db: Db, limit: number): Promise<TournamentListRow[]> {
    const r = await db.prepare(
        `SELECT ${LIST_COLUMNS}
           FROM tournaments t
           ${TOURNAMENT_LIST_WHERE}
          ORDER BY t.last_activity_at DESC
          LIMIT ?`,
    ).bind(limit).all<TournamentListRow>();
    return r.results ?? [];
}

/**
 * The caller's own drafts, which the public list deliberately hides.
 *
 * Without this the create-then-open flow is broken: a tournament is born `draft`, the
 * list drops drafts, and the person who just made one cannot find it to open it. Kept as
 * a separate cheap query rather than folded into the list so the list's memo can stay
 * anonymous — the same split `/stats/community` uses for its per-user flag.
 */
export async function listOwnDrafts(db: Db, userId: string): Promise<TournamentListRow[]> {
    const r = await db.prepare(
        `SELECT ${LIST_COLUMNS}
           FROM tournaments t
          WHERE t.owner_user_id = ? AND t.status = 'draft' AND ${aliveWhereClause('t')}
          ORDER BY t.created_at DESC
          LIMIT 20`,
    ).bind(userId).all<TournamentListRow>();
    return r.results ?? [];
}

/** Rating rows for seeding, for exactly the users asked about. */
export async function ratingsFor(
    db: Db,
    userIds: readonly string[],
    mode: 'default' | 'team',
): Promise<Map<string, { rating: number; rd: number }>> {
    const out = new Map<string, { rating: number; rd: number }>();
    if (userIds.length === 0) return out;
    const marks = userIds.map(() => '?').join(',');
    const r = await db.prepare(
        `SELECT user_id, rating, rd FROM elo_ratings
          WHERE mode = ? AND user_id IN (${marks})`,
    ).bind(mode, ...userIds).all<{ user_id: string; rating: number; rd: number }>();
    for (const row of r.results ?? []) out.set(row.user_id, { rating: row.rating, rd: row.rd });
    return out;
}


// ---------------------------------------------------------------- writes

/**
 * Stamp that somebody still cares about this tournament.
 *
 * Cheap, idempotent, and safe to call more often than strictly needed — the failure mode
 * is one-sided. Forgetting it archives a live tournament; calling it twice costs a write.
 */
export async function touch(db: Db, tournamentId: string): Promise<void> {
    await db.prepare(
        `UPDATE tournaments SET last_activity_at = datetime('now') WHERE id = ?`,
    ).bind(tournamentId).run();
}

/**
 * Take one seat, or find out there was not one.
 *
 * `changes === 0` means full, closed, or gone — the caller does not need to know which,
 * because in every case the answer to the registration is the waitlist. This is the
 * project's own race-safe idiom (see the claims in `matches/rest.ts`) and the reason
 * `confirmed_count` is denormalised at all.
 */
export async function claimSeat(db: Db, tournamentId: string): Promise<boolean> {
    const r = await db.prepare(
        `UPDATE tournaments
            SET confirmed_count = confirmed_count + 1,
                last_activity_at = datetime('now')
          WHERE id = ?
            AND status = 'registration'
            AND confirmed_count < capacity`,
    ).bind(tournamentId).run();
    return r.changes > 0;
}

/**
 * Give a seat back.
 *
 * Floored at zero in SQL rather than trusted to stay positive: the count is denormalised,
 * and a denormalised counter that can go negative turns one lost update into a tournament
 * that can never fill again.
 */
export async function releaseSeat(db: Db, tournamentId: string): Promise<void> {
    await db.prepare(
        `UPDATE tournaments
            SET confirmed_count = MAX(0, confirmed_count - 1),
                last_activity_at = datetime('now')
          WHERE id = ?`,
    ).bind(tournamentId).run();
}

/** Write a generated bracket. One transaction: a half-inserted bracket is unplayable. */
export async function insertBracket(
    db: Db,
    tournamentId: string,
    matches: readonly BracketMatch[],
): Promise<void> {
    // Parents before children would violate the self-referencing FK on next_match_id, so
    // insert the links empty and fill them in a second pass inside the same transaction.
    const inserts = matches.map((m) => db.prepare(
        `INSERT INTO tournament_matches
             (id, tournament_id, round, position, entrant1_id, entrant2_id,
              winner_entrant_id, status, outcome, decided_by, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
        m.id, tournamentId, m.round, m.position, m.entrant1Id, m.entrant2Id,
        m.winnerEntrantId, m.status, m.outcome,
        m.status === 'bye' ? 'bye' : null,
        m.status === 'bye' ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null,
    ));

    const links = matches
        .filter((m) => m.nextMatchId !== null)
        .map((m) => db.prepare(
            `UPDATE tournament_matches SET next_match_id = ?, next_slot = ? WHERE id = ?`,
        ).bind(m.nextMatchId, m.nextSlot, m.id));

    await db.batch([...inserts, ...links]);
}

/**
 * Apply structural updates from the pure bracket module.
 *
 * Only ever sets the columns the bracket owns. `decided_by`, `decided_at` and `match_id`
 * are the caller's, because they are facts about who reported and when — which is why
 * `BracketUpdate` does not carry them.
 */
export async function applyMatchUpdates(
    db: Db,
    updates: readonly BracketUpdate[],
): Promise<void> {
    if (updates.length === 0) return;
    await db.batch(updates.map((u) => db.prepare(
        `UPDATE tournament_matches
            SET entrant1_id = ?, entrant2_id = ?, winner_entrant_id = ?,
                status = ?, outcome = ?
          WHERE id = ?`,
    ).bind(
        u.entrant1Id ?? null, u.entrant2Id ?? null, u.winnerEntrantId ?? null,
        u.status ?? 'pending', u.outcome ?? null, u.id,
    )));
}

/**
 * Claim a bracket slot for a decided game, the way `matches/rest.ts` claims a match row.
 *
 * `false` means somebody got there first — a resent report, or a late reading arriving
 * beside the original. The caller stops rather than advancing twice, which in a bracket
 * would seat the same winner in two rounds.
 */
export async function claimMatchResult(
    db: Db,
    tournamentMatchId: string,
    winnerEntrantId: string,
    outcome: 'played' | 'walkover' | 'dq',
    decidedBy: string,
    matchId: string | null,
): Promise<boolean> {
    const r = await db.prepare(
        `UPDATE tournament_matches
            SET status = 'done', outcome = ?, winner_entrant_id = ?,
                match_id = ?, decided_by = ?, decided_at = datetime('now')
          WHERE id = ? AND status = 'pending'`,
    ).bind(outcome, winnerEntrantId, matchId, decidedBy, tournamentMatchId).run();
    return r.changes > 0;
}

export async function recordMatchGame(
    db: Db,
    tournamentMatchId: string,
    matchId: string,
    winnerEntrantId: string,
    gameNo = 1,
): Promise<void> {
    await db.prepare(
        `INSERT OR IGNORE INTO tournament_match_games
             (tournament_match_id, match_id, game_no, winner_entrant_id)
         VALUES (?, ?, ?, ?)`,
    ).bind(tournamentMatchId, matchId, gameNo, winnerEntrantId).run();
}

export async function finishTournament(
    db: Db,
    tournamentId: string,
    championEntrantId: string | null,
): Promise<void> {
    await db.prepare(
        `UPDATE tournaments
            SET status = 'finished', finished_at = datetime('now'),
                last_activity_at = datetime('now'), winner_entrant_id = ?
          WHERE id = ? AND status = 'running'`,
    ).bind(championEntrantId, tournamentId).run();
}

export interface NewTournament {
    id: string;
    name: string;
    modId: string;
    ownerUserId: string;
    format: TournamentFormat;
    teamSource: TeamSource;
    entryMode: 'open' | 'approval';
    capacity: number;
}

export async function insertTournament(db: Db, t: NewTournament): Promise<void> {
    await db.prepare(
        `INSERT INTO tournaments (id, name, mod_id, owner_user_id, format, team_source,
                                  entry_mode, capacity, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
    ).bind(t.id, t.name, t.modId, t.ownerUserId, t.format, t.teamSource, t.entryMode, t.capacity).run();
}

export interface NewEntrant {
    id: string;
    tournamentId: string;
    kind: 'solo' | 'team';
    teamId: string | null;
    displayName: string;
    captainUserId: string;
    status: EntrantStatus;
}

/**
 * Register an entrant and freeze its roster, in one transaction.
 *
 * The two writes are inseparable: an entrant with no roster rows is a bracket slot nobody
 * can be matched into, and it would pass every later check because the roster is only ever
 * read by joining. Half of this write is worse than none of it.
 */
export async function insertEntrant(
    db: Db,
    e: NewEntrant,
    memberIds: readonly string[],
): Promise<void> {
    await db.batch([
        db.prepare(
            `INSERT INTO tournament_entrants
                 (id, tournament_id, kind, team_id, display_name, captain_user_id, status)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(e.id, e.tournamentId, e.kind, e.teamId, e.displayName, e.captainUserId, e.status),
        ...memberIds.map((uid) => db.prepare(
            `INSERT INTO tournament_entrant_members (entrant_id, user_id) VALUES (?, ?)`,
        ).bind(e.id, uid)),
        db.prepare(
            `UPDATE tournaments SET last_activity_at = datetime('now') WHERE id = ?`,
        ).bind(e.tournamentId),
    ]);
}

export async function getEntrant(db: Db, entrantId: string): Promise<EntrantRow | undefined> {
    return db.prepare(
        `SELECT * FROM tournament_entrants WHERE id = ?`,
    ).bind(entrantId).first<EntrantRow>();
}

/**
 * Move an entrant between statuses, but only from the status the caller believed it was in.
 *
 * The `expected` guard is the same conditional-claim idiom as `claimSeat` and
 * `claimMatchResult`: accepting a withdrawal twice would release two seats for one
 * entrant, and a denormalised counter that drifts down is how a tournament becomes
 * impossible to fill.
 */
export async function setEntrantStatus(
    db: Db,
    entrantId: string,
    next: EntrantStatus,
    expected: readonly EntrantStatus[],
): Promise<boolean> {
    const marks = expected.map(() => '?').join(',');
    const r = await db.prepare(
        `UPDATE tournament_entrants SET status = ?
          WHERE id = ? AND status IN (${marks})`,
    ).bind(next, entrantId, ...expected).run();
    return r.changes > 0;
}

/** Write a whole seeding at once. Partial seeding is what makes `generateBracket` throw. */
export async function setSeeds(
    db: Db,
    tournamentId: string,
    seeds: readonly { entrantId: string; seed: number }[],
): Promise<void> {
    await db.batch([
        ...seeds.map((s) => db.prepare(
            `UPDATE tournament_entrants SET seed = ? WHERE id = ? AND tournament_id = ?`,
        ).bind(s.seed, s.entrantId, tournamentId)),
        db.prepare(
            `UPDATE tournaments SET last_activity_at = datetime('now') WHERE id = ?`,
        ).bind(tournamentId),
    ]);
}

/**
 * Move a tournament between statuses, from an expected one, stamping the right timestamp.
 *
 * `expected` again, for the same reason: two clicks on Start must not generate the bracket
 * twice, and `insertBracket` would happily write a second one.
 */
export async function setTournamentStatus(
    db: Db,
    tournamentId: string,
    next: TournamentStatus,
    expected: readonly TournamentStatus[],
    stampColumn?: 'registration_opened_at' | 'started_at' | 'cancelled_at',
): Promise<boolean> {
    const marks = expected.map(() => '?').join(',');
    const stamp = stampColumn ? `, ${stampColumn} = datetime('now')` : '';
    const r = await db.prepare(
        `UPDATE tournaments
            SET status = ?, last_activity_at = datetime('now')${stamp}
          WHERE id = ? AND status IN (${marks})`,
    ).bind(next, tournamentId, ...expected).run();
    return r.changes > 0;
}

/** Record the bracket size once the bracket exists, for readers that render rounds. */
export async function setBracketSize(db: Db, tournamentId: string, size: number): Promise<void> {
    await db.prepare(
        `UPDATE tournaments SET bracket_size = ? WHERE id = ?`,
    ).bind(size, tournamentId).run();
}

/** Rename / retune before the bracket exists. Capacity is clamped by the route, not here. */
export async function updateTournamentSettings(
    db: Db,
    tournamentId: string,
    fields: { name?: string; capacity?: number; entryMode?: 'open' | 'approval' },
): Promise<void> {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (fields.name !== undefined) { sets.push('name = ?'); binds.push(fields.name); }
    if (fields.capacity !== undefined) { sets.push('capacity = ?'); binds.push(fields.capacity); }
    if (fields.entryMode !== undefined) { sets.push('entry_mode = ?'); binds.push(fields.entryMode); }
    if (sets.length === 0) return;
    await db.prepare(
        `UPDATE tournaments SET ${sets.join(', ')}, last_activity_at = datetime('now') WHERE id = ?`,
    ).bind(...binds, tournamentId).run();
}

/**
 * Archive every tournament that has gone quiet.
 *
 * Called once at startup. Deliberately NOT on a timer: staleness is already honoured by
 * the list query and both caps, so this only makes the stored status agree with what
 * players have been seeing. See `lifecycle.ts`.
 *
 * Returns the ids it archived so the caller can close their bound rooms and log them.
 */
export async function archiveStale(db: Db, staleClause: string): Promise<string[]> {
    const doomed = await db.prepare(
        `SELECT t.id FROM tournaments t WHERE ${staleClause}`,
    ).bind().all<{ id: string }>();
    const ids = (doomed.results ?? []).map((r) => r.id);
    if (ids.length === 0) return [];

    await db.batch(ids.map((id) => db.prepare(
        `UPDATE tournaments
            SET status = 'abandoned', abandoned_at = datetime('now')
          WHERE id = ? AND status NOT IN ('finished','cancelled','abandoned')`,
    ).bind(id)));
    return ids;
}
