/**
 * Operator commands for the lobby server — inspect and repair rooms, matches, ratings
 * and players from a shell on the VM.
 *
 * Run: `sudo -u wol-lobby ./node_modules/.bin/tsx scripts/admin.ts <command>`  (dry run)
 *      `sudo -u wol-lobby ./node_modules/.bin/tsx scripts/admin.ts <command> --apply`
 *      `npm run admin -- <command>`                                    (same, shorter)
 *      `... scripts/admin.ts <command> /path/to/lobby.db --apply`
 *
 * Why this exists. There was no operator surface at all: no admin route, no role, no
 * privileged anything. Everything was `systemctl`, `journalctl`, and SQL typed by hand out
 * of DEPLOY.md — so a stuck room, a match that scored wrong, or a player locked out of every
 * lobby had no tool to look at it with, let alone fix it.
 *
 * A SCRIPT and not a route, for the reason reset-elo.ts and upgrade-pending.ts give: these
 * change history people have already seen, and that is a decision an operator takes
 * deliberately. It also keeps the server's public surface exactly as small as it is today.
 *
 * DRY RUN BY DEFAULT, everywhere. Every mutating command prints what it would do and writes
 * nothing until `--apply`. The commands that move ratings go further: the dry run performs
 * the whole change on a throwaway snapshot of the database and prints the REAL resulting
 * rating movement, so nobody has to take the summary on faith.
 *
 * <p><b>What it cannot do, and says so at the point of use.</b> The server keeps live state
 * in memory — attached sockets, the in-RAM room registry, the global-chat ring and its
 * mutes, the Discord embed for each room. A script writes SQLite and nothing else. So
 * `rooms:close` frees the row and the slot and unblocks the members, but it cannot hang up a
 * socket that is still open or repaint a Discord message; those wait for the sockets to drop
 * or for a restart. The common ghost — a room created and never connected to — has no
 * sockets at all, and for that one this is a complete fix.</p>
 */
import 'dotenv/config';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { Db } from '../src/db';
import {
    applyMatch,
    DEFAULT_RATING,
    DEFAULT_RD,
    DEFAULT_VOLATILITY,
    type ParticipantOutcome,
} from '../src/elo/glicko2';

// ---------------------------------------------------------------- argv

const ARGV = process.argv.slice(2);
const COMMAND = ARGV.find((a) => !a.startsWith('--')) ?? 'help';
const APPLY = ARGV.includes('--apply');

/** Positional arguments after the command, in order, excluding flags and the db path. */
function positionals(): string[] {
    const all = ARGV.filter((a) => !a.startsWith('--'));
    // The db path is recognised by shape — it is the only positional that looks like a
    // path. Anything else is the command's own argument.
    return all.slice(1).filter((a) => !looksLikeDbPath(a));
}

function looksLikeDbPath(a: string): boolean {
    return a.endsWith('.db') || a.includes('/') || a.includes('\\');
}

function resolveDbPath(): string {
    const positional = ARGV.filter((a) => !a.startsWith('--')).find(looksLikeDbPath);
    return positional || process.env.DB_PATH || './lobby.db';
}

/** `--flag value` or `--flag=value`. */
function flag(name: string): string | null {
    const eq = ARGV.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = ARGV.indexOf(`--${name}`);
    if (i >= 0 && ARGV[i + 1] && !ARGV[i + 1]!.startsWith('--')) return ARGV[i + 1]!;
    return null;
}

/** `6h`, `90m`, `2d` → milliseconds. Returns null when unparseable. */
function parseDuration(s: string | null): number | null {
    if (!s) return null;
    const m = /^(\d+)\s*([mhd])$/.exec(s.trim());
    if (!m) return null;
    const n = Number(m[1]);
    return m[2] === 'm' ? n * 60_000 : m[2] === 'h' ? n * 3_600_000 : n * 86_400_000;
}

// ---------------------------------------------------------------- output

function pad(s: unknown, w: number): string {
    const v = s === null || s === undefined ? '-' : String(s);
    return v.length >= w ? v.slice(0, w) : v + ' '.repeat(w - v.length);
}

function num(v: number | null | undefined, digits = 0): string {
    return v === null || v === undefined ? '-' : v.toFixed(digits);
}

/** The closing line every mutating command ends on. Keeps one wording for the whole tool. */
function summarise(changed: number, what: string): void {
    console.log(
        changed === 0
            ? `Nothing to change.`
            : APPLY
                ? `Done — ${changed} ${what}.`
                : `${changed} ${what} would change. Re-run with --apply to write.`,
    );
}

// ---------------------------------------------------------------- rows

interface UserRow {
    id: string;
    discord_username: string;
    display_name: string;
    is_banned: number;
    ban_reason: string | null;
}

interface MatchRow {
    id: string;
    lobby_id: string | null;
    host_user_id: string;
    mod_id: string;
    map_name: string | null;
    duration_seconds: number;
    started_at: string;
    ended_at: string;
    created_at: string;
    rated: number | null;
    unrated_reason: string | null;
    decided_by: string | null;
    replay_sha256: string | null;
    game_seed: number | null;
    game_host_time: number | null;
}

interface ParticipantRow {
    match_id: string;
    user_id: string;
    result: number;
    rating_before: number | null;
    rating_after: number | null;
    display_name: string | null;
}

/**
 * Find one user by internal id, Discord username or display name.
 *
 * <p>Accepting all three matters because the three surfaces an operator reads disagree about
 * which one they show: the logs carry the internal id, Discord carries the username, and the
 * launcher shows the display name. An ambiguous name prints the candidates and stops rather
 * than picking one — banning or resetting the wrong person is not recoverable from here.</p>
 */
async function findUser(db: Db, needle: string): Promise<UserRow | null> {
    const rows = await db.prepare(
        `SELECT id, discord_username, display_name, is_banned, ban_reason
         FROM users
         WHERE id = ? OR lower(discord_username) = lower(?) OR lower(display_name) = lower(?)`,
    ).bind(needle, needle, needle).all<UserRow>();

    const found = rows.results ?? [];
    if (found.length === 0) {
        console.log(`No user matches '${needle}'.`);
        return null;
    }
    if (found.length > 1) {
        console.log(`'${needle}' is ambiguous — ${found.length} users match:`);
        for (const u of found) console.log(`  ${u.id}  ${u.discord_username}  (${u.display_name})`);
        console.log('Re-run with the id.');
        return null;
    }
    return found[0]!;
}

// ---------------------------------------------------------------- snapshot

/**
 * Run <paramref name="fn"/> against a throwaway copy of the database.
 *
 * <p>This is what lets a dry run of a rating change show the REAL numbers instead of a
 * promise. The rating engine writes as it computes and has no inverse, so there is no way to
 * "compute without writing" — but there is a way to write somewhere that does not matter.</p>
 *
 * <p><c>VACUUM INTO</c> rather than copying the file: the database runs in WAL mode, so the
 * `.db` on its own is not a complete picture and a plain copy taken while the service is
 * writing can miss committed transactions. VACUUM INTO asks SQLite for a consistent snapshot
 * and is safe with the service running.</p>
 */
async function withSnapshot<T>(dbPath: string, fn: (snap: Db) => Promise<T>): Promise<T> {
    const out = join(tmpdir(), `wol-admin-snap-${process.pid}-${Date.now()}.db`);
    const source = new Db(dbPath);
    try {
        source.raw().exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    } finally {
        source.close();
    }
    const snap = new Db(out);
    try {
        return await fn(snap);
    } finally {
        snap.close();
        for (const suffix of ['', '-wal', '-shm']) {
            rmSync(out + suffix, { force: true });
        }
    }
}

// ---------------------------------------------------------------- ratings

/**
 * Rebuild the whole ladder by replaying every rated match in order.
 *
 * <p>This is the tool's centre of gravity. <c>applyMatch</c> has no inverse and nothing
 * snapshots a player's prior state, so "undo this match" cannot be computed — but "recompute
 * the ladder as though this match had always read the way it now reads" can, and it is
 * exactly as correct. Every correction command therefore edits the row and calls this.</p>
 *
 * <p>It also repairs a corruption nothing else detects. If anything throws after
 * <c>applyMatch</c> inside <c>maybeUpgradeFromConfirmation</c>, that path rolls back the
 * match and participant rows but NOT <c>elo_ratings</c> — the players keep the points and the
 * match becomes eligible to be rated a second time. A replay simply cannot express that
 * state.</p>
 *
 * <p><b>Order is <c>created_at</c>, not <c>started_at</c></b>: ratings were applied when each
 * match was REPORTED, and reports do not always arrive in the order the games were played.
 * Replaying by report order is the faithful reproduction.</p>
 *
 * <p>Ratings rows are reset in place rather than deleted, so a player who signed up and never
 * played keeps the 1500/350 row the signup created. Deleting would silently change who has a
 * row at all.</p>
 */
export async function recomputeLadder(db: Db): Promise<{ matches: number; players: number }> {
    const rated = await db.prepare(
        `SELECT id FROM matches
          WHERE rated = 1
             OR (rated IS NULL AND EXISTS (
                    SELECT 1 FROM match_participants p
                     WHERE p.match_id = matches.id AND p.rating_after IS NOT NULL))
          ORDER BY created_at ASC, id ASC`,
    ).bind().all<{ id: string }>();

    const ids = (rated.results ?? []).map((r) => r.id);

    await db.prepare(
        `UPDATE elo_ratings
            SET rating = ?, rd = ?, volatility = ?, games_played = 0, updated_at = datetime('now')`,
    ).bind(DEFAULT_RATING, DEFAULT_RD, DEFAULT_VOLATILITY).run();

    // Every stamp is rewritten below for the matches that still count; clearing first is what
    // removes stamps from a match that has just stopped counting.
    await db.prepare(
        `UPDATE match_participants SET rating_before = NULL, rating_after = NULL`,
    ).bind().run();

    const touched = new Set<string>();
    for (const matchId of ids) {
        const parts = await db.prepare(
            `SELECT match_id, user_id, result FROM match_participants
              WHERE match_id = ? ORDER BY user_id ASC`,
        ).bind(matchId).all<ParticipantRow>();

        const outcomes: ParticipantOutcome[] = (parts.results ?? []).map((p) => ({
            userId: p.user_id,
            result: p.result as 0 | 0.5 | 1,
        }));
        if (outcomes.length < 2) continue;

        const diff = await applyMatch(db, outcomes);
        const stamps = [];
        for (const o of outcomes) {
            touched.add(o.userId);
            const d = diff.get(o.userId);
            if (!d) continue;
            stamps.push(db.prepare(
                `UPDATE match_participants SET rating_before = ?, rating_after = ?
                  WHERE match_id = ? AND user_id = ?`,
            ).bind(d.before, d.after, matchId, o.userId));
        }
        if (stamps.length) await db.batch(stamps);
    }

    return { matches: ids.length, players: touched.size };
}

interface RatingRow {
    user_id: string;
    rating: number;
    rd: number;
    games_played: number;
    display_name: string | null;
}

export async function readRatings(db: Db): Promise<Map<string, RatingRow>> {
    const rows = await db.prepare(
        `SELECT e.user_id, e.rating, e.rd, e.games_played, u.display_name
           FROM elo_ratings e LEFT JOIN users u ON u.id = e.user_id
          WHERE e.mode = 'default'`,
    ).bind().all<RatingRow>();
    const map = new Map<string, RatingRow>();
    for (const r of rows.results ?? []) map.set(r.user_id, r);
    return map;
}

/** Print who moved between two ladders. The empty case is the interesting one for --verify. */
function printRatingDiff(before: Map<string, RatingRow>, after: Map<string, RatingRow>): number {
    const ids = new Set([...before.keys(), ...after.keys()]);
    let moved = 0;
    for (const id of [...ids].sort()) {
        const b = before.get(id);
        const a = after.get(id);
        const rb = b?.rating ?? null;
        const ra = a?.rating ?? null;
        if (rb !== null && ra !== null && Math.abs(rb - ra) < 0.0005
            && b!.games_played === a!.games_played) continue;
        moved++;
        const who = a?.display_name ?? b?.display_name ?? id;
        console.log(
            `  ${pad(who, 22)} ${pad(num(rb, 1), 8)} -> ${pad(num(ra, 1), 8)}` +
            `  games ${b?.games_played ?? '-'} -> ${a?.games_played ?? '-'}`,
        );
    }
    return moved;
}

/**
 * Perform a rating-moving change: on a snapshot when this is a dry run, on the real database
 * when it is not. Either way the operator sees the actual movement before or as it happens.
 */
async function withRatingChange(
    dbPath: string,
    label: string,
    mutate: (db: Db) => Promise<boolean>,
): Promise<void> {
    const run = async (db: Db, real: boolean): Promise<void> => {
        const before = await readRatings(db);
        const ok = await mutate(db);
        if (!ok) return;
        const { matches } = await recomputeLadder(db);
        const after = await readRatings(db);

        console.log(`Ladder replayed from ${matches} rated match(es).`);
        const moved = printRatingDiff(before, after);
        if (moved === 0) console.log('  (no rating moved)');
        console.log(
            real
                ? `Done — ${label}.`
                : `${label}. Nothing was written — re-run with --apply.`,
        );
    };

    if (APPLY) {
        const db = new Db(dbPath);
        try { await run(db, true); } finally { db.close(); }
    } else {
        await withSnapshot(dbPath, (snap) => run(snap, false));
    }
}

// ---------------------------------------------------------------- commands

async function cmdStatus(db: Db): Promise<void> {
    const rooms = await db.prepare(
        `SELECT status, COUNT(*) AS n FROM lobbies GROUP BY status ORDER BY status`,
    ).bind().all<{ status: string; n: number }>();

    console.log('Rooms');
    const roomRows = rooms.results ?? [];
    if (roomRows.length === 0) console.log('  (none)');
    for (const r of roomRows) console.log(`  ${pad(r.status, 10)} ${r.n}`);

    const today = await db.prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN rated = 1 THEN 1 ELSE 0 END) AS rated
           FROM matches WHERE started_at >= date('now')`,
    ).bind().first<{ total: number; rated: number | null }>();

    console.log('Matches today');
    console.log(`  total ${today?.total ?? 0}   rated ${today?.rated ?? 0}`);

    const reasons = await db.prepare(
        `SELECT unrated_reason, COUNT(*) AS n FROM matches
          WHERE unrated_reason IS NOT NULL GROUP BY unrated_reason ORDER BY n DESC`,
    ).bind().all<{ unrated_reason: string; n: number }>();

    console.log('Unrated, all time');
    const reasonRows = reasons.results ?? [];
    if (reasonRows.length === 0) console.log('  (none)');
    for (const r of reasonRows) console.log(`  ${pad(r.unrated_reason, 26)} ${r.n}`);

    const players = await db.prepare(
        `SELECT COUNT(*) AS n FROM elo_ratings WHERE mode = 'default' AND games_played > 0`,
    ).bind().first<{ n: number }>();
    const banned = await db.prepare(
        `SELECT COUNT(*) AS n FROM users WHERE is_banned = 1`,
    ).bind().first<{ n: number }>();

    console.log('Players');
    console.log(`  with games ${players?.n ?? 0}   banned ${banned?.n ?? 0}`);
}

interface LobbyRow {
    id: string;
    host_user_id: string;
    title: string | null;
    status: string;
    created_at: string;
    host: string | null;
    members: number;
    age_min: number;
}

async function selectLobbies(db: Db, where: string, params: unknown[]): Promise<LobbyRow[]> {
    const rows = await db.prepare(
        `SELECT l.id, l.host_user_id, l.title, l.status, l.created_at,
                u.display_name AS host,
                (SELECT COUNT(*) FROM lobby_members m WHERE m.lobby_id = l.id) AS members,
                CAST((julianday('now') - julianday(l.created_at)) * 1440 AS INTEGER) AS age_min
           FROM lobbies l LEFT JOIN users u ON u.id = l.host_user_id
          ${where}
          ORDER BY l.created_at DESC`,
    ).bind(...params).all<LobbyRow>();
    return rows.results ?? [];
}

/** Rooms that look wrong: open with nobody in them, or stuck mid-game for hours. */
function isStale(r: LobbyRow): boolean {
    if (r.status === 'closed') return false;
    if (r.status === 'in_game' && r.age_min > 180) return true;
    return r.status === 'open' && r.members === 0;
}

async function cmdRoomsList(db: Db): Promise<void> {
    const onlyStale = ARGV.includes('--stale');
    const rows = await selectLobbies(db, `WHERE l.status != 'closed'`, []);
    const shown = onlyStale ? rows.filter(isStale) : rows;

    console.log(`${shown.length} room(s)${onlyStale ? ' flagged stale' : ' open'}.`);
    if (shown.length === 0) return;
    console.log(`  ${pad('ID', 10)} ${pad('STATUS', 9)} ${pad('HOST', 20)} ${pad('AGE', 8)} ${pad('MEM', 4)} TITLE`);
    for (const r of shown) {
        const age = r.age_min >= 60 ? `${Math.floor(r.age_min / 60)}h${r.age_min % 60}m` : `${r.age_min}m`;
        console.log(
            `  ${pad(r.id, 10)} ${pad(r.status, 9)} ${pad(r.host ?? r.host_user_id, 20)}` +
            ` ${pad(age, 8)} ${pad(r.members, 4)} ${r.title ?? ''}${isStale(r) ? '   <- stale' : ''}`,
        );
    }
}

/**
 * Close rooms and release their members.
 *
 * <p>Deleting the <c>lobby_members</c> rows is not tidiness, it is the point. The "you are
 * already in another lobby" guard queries that table WITHOUT joining lobby status, so a row
 * left behind by a closed room bars that player from joining ANY room, permanently. Every
 * close path in the server except one leaves those rows behind.</p>
 */
async function closeLobbies(db: Db, rows: LobbyRow[]): Promise<number> {
    for (const r of rows) {
        console.log(`  ${r.id}  ${pad(r.status, 9)} host=${r.host ?? r.host_user_id}  members=${r.members}`);
        if (!APPLY) continue;
        await db.batch([
            db.prepare(
                `UPDATE lobbies SET status = 'closed', closed_at = datetime('now')
                  WHERE id = ? AND status != 'closed'`,
            ).bind(r.id),
            db.prepare(`DELETE FROM lobby_members WHERE lobby_id = ?`).bind(r.id),
        ]);
    }
    if (rows.length > 0) {
        console.log('Note: open sockets and the Discord message are in the server process —');
        console.log('      this frees the row, the slot and the members, not those.');
    }
    return rows.length;
}

async function cmdRoomsClose(db: Db): Promise<void> {
    const id = positionals()[0];
    if (!id) { console.log('Usage: rooms:close <lobbyId> [--apply]'); return; }

    const rows = await selectLobbies(db, `WHERE l.id = ?`, [id]);
    if (rows.length === 0) { console.log(`No room '${id}'.`); return; }
    summarise(await closeLobbies(db, rows), 'room(s)');
}

async function cmdRoomsPrune(db: Db): Promise<void> {
    const ms = parseDuration(flag('older-than'));
    if (ms === null) {
        console.log('Usage: rooms:prune --older-than <30m|6h|2d> [--apply]');
        return;
    }
    const minutes = Math.round(ms / 60_000);
    const rows = (await selectLobbies(db, `WHERE l.status != 'closed'`, []))
        .filter((r) => r.age_min >= minutes);

    console.log(`${rows.length} room(s) older than ${flag('older-than')}.`);
    summarise(await closeLobbies(db, rows), 'room(s)');
}

async function cmdMatchList(db: Db): Promise<void> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (ARGV.includes('--unrated')) clauses.push(`(m.rated = 0 OR m.unrated_reason IS NOT NULL)`);
    const since = flag('since');
    if (since) { clauses.push(`m.started_at >= ?`); params.push(since); }
    const limit = Number(flag('limit') ?? 30);

    const rows = await db.prepare(
        `SELECT m.id, m.mod_id, m.map_name, m.started_at, m.rated, m.unrated_reason,
                m.duration_seconds
           FROM matches m
          ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
          ORDER BY m.started_at DESC LIMIT ?`,
    ).bind(...params, limit).all<MatchRow>();

    const found = rows.results ?? [];
    console.log(`${found.length} match(es).`);
    if (found.length === 0) return;
    console.log(`  ${pad('ID', 38)} ${pad('WHEN', 20)} ${pad('MAP', 16)} ${pad('RATED', 6)} REASON`);
    for (const m of found) {
        console.log(
            `  ${pad(m.id, 38)} ${pad(m.started_at, 20)} ${pad(m.map_name, 16)}` +
            ` ${pad(m.rated === 1 ? 'yes' : m.rated === 0 ? 'no' : '?', 6)} ${m.unrated_reason ?? ''}`,
        );
    }
}

async function cmdMatchShow(db: Db): Promise<void> {
    const id = positionals()[0];
    if (!id) { console.log('Usage: match:show <matchId>'); return; }

    const m = await db.prepare(`SELECT * FROM matches WHERE id = ?`).bind(id).first<MatchRow>();
    if (!m) { console.log(`No match '${id}'.`); return; }

    console.log(`Match ${m.id}`);
    console.log(`  mod        ${m.mod_id}          map ${m.map_name ?? '-'}`);
    console.log(`  played     ${m.started_at} -> ${m.ended_at}  (${m.duration_seconds}s)`);
    console.log(`  reported   ${m.created_at}      lobby ${m.lobby_id ?? '-'}`);
    console.log(`  rated      ${m.rated === 1 ? 'yes' : m.rated === 0 ? 'no' : 'unknown (pre-migration)'}`);
    console.log(`  reason     ${m.unrated_reason ?? '-'}        decided_by ${m.decided_by ?? '-'}`);
    console.log(`  seed       ${m.game_seed ?? '-'}   hostTime ${m.game_host_time ?? '-'}`);
    console.log(`  replay     ${m.replay_sha256 ?? '-'}`);

    const parts = await db.prepare(
        `SELECT p.match_id, p.user_id, p.result, p.rating_before, p.rating_after,
                u.display_name
           FROM match_participants p LEFT JOIN users u ON u.id = p.user_id
          WHERE p.match_id = ? ORDER BY p.result DESC`,
    ).bind(id).all<ParticipantRow>();

    console.log('  participants');
    for (const p of parts.results ?? []) {
        console.log(
            `    ${pad(p.display_name ?? p.user_id, 22)} result ${p.result}` +
            `   elo ${pad(num(p.rating_before, 1), 8)} -> ${num(p.rating_after, 1)}`,
        );
    }

    if (!m.lobby_id) return;
    const confs = await db.prepare(
        `SELECT c.user_id, c.result, c.agreement, c.same_game, c.game_seed, u.display_name
           FROM match_confirmations c LEFT JOIN users u ON u.id = c.user_id
          WHERE c.lobby_id = ?`,
    ).bind(m.lobby_id).all<{
        user_id: string; result: number; agreement: string | null;
        same_game: string | null; game_seed: number | null; display_name: string | null;
    }>();

    const rows = confs.results ?? [];
    console.log(`  confirmations (${rows.length})`);
    for (const c of rows) {
        console.log(
            `    ${pad(c.display_name ?? c.user_id, 22)} said ${c.result}` +
            `   agreement ${pad(c.agreement, 14)} same_game ${pad(c.same_game, 8)} seed ${c.game_seed ?? '-'}`,
        );
    }
}

/**
 * Settle a match by hand and replay the ladder.
 *
 * <p>Covers what nothing else can: a match stored `no_decided_result` whose opponent never
 * sent a reading at all (so `upgrade-pending.ts` has nothing to pair with), and one stamped
 * with a verdict that was wrong at the time — `mod_not_ranked` from a stale RANKED_MOD_IDS,
 * or `duplicate_recording` on a genuine game.</p>
 */
async function cmdMatchDecide(dbPath: string): Promise<void> {
    const id = positionals()[0];
    const winner = flag('winner');
    if (!id || !winner) {
        console.log('Usage: match:decide <matchId> --winner <player> [--apply]');
        return;
    }

    await withRatingChange(dbPath, `match ${id} decided`, async (db) => {
        const m = await db.prepare(`SELECT * FROM matches WHERE id = ?`).bind(id).first<MatchRow>();
        if (!m) { console.log(`No match '${id}'.`); return false; }

        const user = await findUser(db, winner);
        if (!user) return false;

        const parts = await db.prepare(
            `SELECT match_id, user_id, result FROM match_participants WHERE match_id = ?`,
        ).bind(id).all<ParticipantRow>();
        const rows = parts.results ?? [];

        if (rows.length !== 2) {
            console.log(`Match has ${rows.length} participants — only a 1v1 can be decided here.`);
            return false;
        }
        if (!rows.some((p) => p.user_id === user.id)) {
            console.log(`${user.display_name} did not play in this match.`);
            return false;
        }

        console.log(`Match ${id}: winner ${user.display_name}, was '${m.unrated_reason ?? 'rated'}'.`);
        await db.batch([
            db.prepare(
                `UPDATE matches SET unrated_reason = NULL, rated = 1, decided_by = 'operator'
                  WHERE id = ?`,
            ).bind(id),
            ...rows.map((p) => db.prepare(
                `UPDATE match_participants SET result = ? WHERE match_id = ? AND user_id = ?`,
            ).bind(p.user_id === user.id ? 1.0 : 0.0, id, p.user_id)),
        ]);
        return true;
    });
}

async function cmdMatchVoid(dbPath: string): Promise<void> {
    const id = positionals()[0];
    if (!id) { console.log('Usage: match:void <matchId> [--apply]'); return; }

    await withRatingChange(dbPath, `match ${id} voided`, async (db) => {
        const m = await db.prepare(`SELECT * FROM matches WHERE id = ?`).bind(id).first<MatchRow>();
        if (!m) { console.log(`No match '${id}'.`); return false; }

        console.log(`Match ${id}: voiding (was rated=${m.rated}, reason='${m.unrated_reason ?? '-'}').`);
        // The row is KEPT. It happened, and deleting it would make the history a player has
        // already seen disagree with itself; it just stops counting.
        await db.batch([
            db.prepare(
                `UPDATE matches SET rated = 0, unrated_reason = 'voided_by_operator', decided_by = 'operator'
                  WHERE id = ?`,
            ).bind(id),
            db.prepare(
                `UPDATE match_participants SET result = 0.5 WHERE match_id = ?`,
            ).bind(id),
        ]);
        return true;
    });
}

/**
 * Rebuild the ladder from match history.
 *
 * <p>Run it with no other change to CHECK the tool: on untouched data the replay must
 * reproduce the ratings that are already there. If it moves somebody, the replay is not
 * faithful and no correction command should be trusted until that is understood.</p>
 */
async function cmdEloRecompute(dbPath: string): Promise<void> {
    await withRatingChange(dbPath, 'ladder recomputed', async () => true);
}

async function cmdPlayerShow(db: Db): Promise<void> {
    const needle = positionals()[0];
    if (!needle) { console.log('Usage: player:show <player>'); return; }
    const u = await findUser(db, needle);
    if (!u) return;

    const r = await db.prepare(
        `SELECT rating, rd, volatility, games_played, updated_at
           FROM elo_ratings WHERE user_id = ? AND mode = 'default'`,
    ).bind(u.id).first<{
        rating: number; rd: number; volatility: number; games_played: number; updated_at: string;
    }>();

    console.log(`${u.display_name}  (${u.discord_username})`);
    console.log(`  id       ${u.id}`);
    console.log(`  banned   ${u.is_banned === 1 ? `yes — ${u.ban_reason ?? 'no reason recorded'}` : 'no'}`);
    console.log(
        r
            ? `  rating   ${num(r.rating, 1)}  rd ${num(r.rd, 1)}  games ${r.games_played}  (${r.updated_at})`
            : `  rating   no row — counts as ${DEFAULT_RATING}/${DEFAULT_RD}`,
    );

    const stuck = await db.prepare(
        `SELECT m.lobby_id, l.status FROM lobby_members m
           LEFT JOIN lobbies l ON l.id = m.lobby_id WHERE m.user_id = ?`,
    ).bind(u.id).all<{ lobby_id: string; status: string | null }>();

    for (const s of stuck.results ?? []) {
        const bad = s.status === null || s.status === 'closed';
        console.log(`  member of ${s.lobby_id} (${s.status ?? 'missing'})${bad ? '   <- blocks every join; player:unstick' : ''}`);
    }
}

async function cmdPlayerHistory(db: Db): Promise<void> {
    const needle = positionals()[0];
    if (!needle) { console.log('Usage: player:history <player> [--limit N]'); return; }
    const u = await findUser(db, needle);
    if (!u) return;
    const limit = Number(flag('limit') ?? 20);

    const rows = await db.prepare(
        `SELECT m.id, m.started_at, m.map_name, m.rated, m.unrated_reason,
                p.result, p.rating_before, p.rating_after
           FROM match_participants p JOIN matches m ON m.id = p.match_id
          WHERE p.user_id = ? ORDER BY m.started_at DESC LIMIT ?`,
    ).bind(u.id, limit).all<MatchRow & ParticipantRow>();

    const found = rows.results ?? [];
    console.log(`${found.length} match(es) for ${u.display_name}.`);
    for (const m of found) {
        const verdict = m.result === 1 ? 'win' : m.result === 0 ? 'loss' : 'draw/none';
        console.log(
            `  ${pad(m.started_at, 20)} ${pad(m.map_name, 16)} ${pad(verdict, 10)}` +
            ` elo ${pad(num(m.rating_before, 1), 8)} -> ${pad(num(m.rating_after, 1), 8)}` +
            ` ${m.rated === 1 ? '' : m.unrated_reason ?? 'unrated'}`,
        );
    }
}

async function cmdPlayerReset(dbPath: string): Promise<void> {
    const needle = positionals()[0];
    if (!needle) { console.log('Usage: player:reset <player> [--apply]'); return; }

    // Not routed through withRatingChange: this deliberately does NOT replay history, which
    // would put the rating straight back. It is a manual override, and the next recompute
    // will overwrite it — which is worth knowing before reaching for it.
    const db = new Db(dbPath);
    try {
        const u = await findUser(db, needle);
        if (!u) return;
        console.log(`  ${u.display_name}: rating -> ${DEFAULT_RATING}, rd -> ${DEFAULT_RD}, games -> 0`);
        console.log('Note: this does not erase their matches, so an elo:recompute would undo it.');
        if (APPLY) {
            await db.prepare(
                `UPDATE elo_ratings SET rating = ?, rd = ?, volatility = ?, games_played = 0,
                        updated_at = datetime('now')
                  WHERE user_id = ? AND mode = 'default'`,
            ).bind(DEFAULT_RATING, DEFAULT_RD, DEFAULT_VOLATILITY, u.id).run();
        }
        summarise(1, 'player');
    } finally {
        db.close();
    }
}

async function cmdPlayerBan(db: Db, ban: boolean): Promise<void> {
    const needle = positionals()[0];
    if (!needle) { console.log(`Usage: player:${ban ? 'ban <player> --reason "..."' : 'unban <player>'} [--apply]`); return; }
    const u = await findUser(db, needle);
    if (!u) return;

    if (ban && u.is_banned === 1) { console.log(`${u.display_name} is already banned.`); return; }
    if (!ban && u.is_banned === 0) { console.log(`${u.display_name} is not banned.`); return; }

    const reason = flag('reason');
    console.log(`  ${u.display_name} (${u.discord_username}) -> ${ban ? `banned: ${reason ?? 'no reason given'}` : 'unbanned'}`);
    if (APPLY) {
        await db.prepare(
            `UPDATE users SET is_banned = ?, ban_reason = ? WHERE id = ?`,
        ).bind(ban ? 1 : 0, ban ? reason : null, u.id).run();
    }
    if (ban) {
        console.log('Their open sockets stay up until they drop — the ban bites on the next request.');
    }
    summarise(1, 'player');
}

/**
 * Clear membership rows that point at a room which is gone.
 *
 * <p>The join guard reads `lobby_members` without joining lobby status, so one stale row is a
 * permanent, silent ban from every room. The player cannot clear it themselves by joining —
 * joining is exactly what is refused.</p>
 */
async function cmdPlayerUnstick(db: Db): Promise<void> {
    const needle = positionals()[0];
    if (!needle) { console.log('Usage: player:unstick <player> [--apply]'); return; }
    const u = await findUser(db, needle);
    if (!u) return;

    const rows = await db.prepare(
        `SELECT m.lobby_id, l.status FROM lobby_members m
           LEFT JOIN lobbies l ON l.id = m.lobby_id
          WHERE m.user_id = ? AND (l.id IS NULL OR l.status = 'closed')`,
    ).bind(u.id).all<{ lobby_id: string; status: string | null }>();

    const stale = rows.results ?? [];
    console.log(`${stale.length} stale membership row(s) for ${u.display_name}.`);
    for (const s of stale) console.log(`  ${s.lobby_id} (${s.status ?? 'missing'})`);

    if (APPLY && stale.length > 0) {
        await db.batch(stale.map((s) => db.prepare(
            `DELETE FROM lobby_members WHERE lobby_id = ? AND user_id = ?`,
        ).bind(s.lobby_id, u.id)));
    }
    summarise(stale.length, 'membership row(s)');
}

function usage(): void {
    console.log(`Operator commands. Dry run by default; add --apply to write.

  status                                    rooms, today's matches, unrated breakdown
  rooms:list [--stale]                      open rooms; --stale flags the suspicious ones
  rooms:close <id>                          close it and release its members
  rooms:prune --older-than <6h>             the same, in bulk
  match:list [--unrated] [--since D] [--limit N]
  match:show <id>                           participants, verdict, confirmations, elo
  match:decide <id> --winner <player>       settle a stuck match, then replay the ladder
  match:void <id>                           stop it counting, then replay the ladder
  elo:recompute                             replay the ladder; run it alone to self-check
  player:show <player>                      rating, ban state, stale memberships
  player:history <player> [--limit N]
  player:reset <player>                     one player back to ${DEFAULT_RATING}
  player:ban <player> --reason "..."        |  player:unban <player>
  player:unstick <player>                   clear rows that bar them from every room

A player is matched by id, Discord username or display name.
The database is the positional path, else DB_PATH, else ./lobby.db.`);
}

// ---------------------------------------------------------------- main

/** Every command name, so an unknown one is refused before any database is opened. */
const KNOWN = new Set([
    'status',
    'rooms:list', 'rooms:close', 'rooms:prune',
    'match:list', 'match:show', 'match:decide', 'match:void',
    'elo:recompute',
    'player:show', 'player:history', 'player:reset',
    'player:ban', 'player:unban', 'player:unstick',
]);

async function main(): Promise<void> {
    // Answered before anything opens a database: better-sqlite3 CREATES the file it is
    // pointed at, so `admin.ts help` run from the wrong directory would leave a stray empty
    // lobby.db behind — and a typo'd command would do the same.
    if (COMMAND === 'help') return usage();
    if (!KNOWN.has(COMMAND)) {
        console.log(`Unknown command '${COMMAND}'.\n`);
        return usage();
    }

    const dbPath = resolveDbPath();

    // The rating commands manage their own connection: a dry run has to open a snapshot
    // instead of the real database, and that decision belongs to them.
    if (COMMAND === 'match:decide') return cmdMatchDecide(dbPath);
    if (COMMAND === 'match:void') return cmdMatchVoid(dbPath);
    if (COMMAND === 'elo:recompute') return cmdEloRecompute(dbPath);
    if (COMMAND === 'player:reset') return cmdPlayerReset(dbPath);

    const db = new Db(dbPath);
    try {
        switch (COMMAND) {
            case 'status': return await cmdStatus(db);
            case 'rooms:list': return await cmdRoomsList(db);
            case 'rooms:close': return await cmdRoomsClose(db);
            case 'rooms:prune': return await cmdRoomsPrune(db);
            case 'match:list': return await cmdMatchList(db);
            case 'match:show': return await cmdMatchShow(db);
            case 'player:show': return await cmdPlayerShow(db);
            case 'player:history': return await cmdPlayerHistory(db);
            case 'player:ban': return await cmdPlayerBan(db, true);
            case 'player:unban': return await cmdPlayerBan(db, false);
            case 'player:unstick': return await cmdPlayerUnstick(db);
        }
    } finally {
        db.close();
    }
}

// Only when run as a command. The rating replay is the one piece here worth testing on its
// own, and a module that runs itself on import cannot be imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
