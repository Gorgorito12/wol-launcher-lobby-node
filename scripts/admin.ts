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
import { meetsMinimum } from '../src/lib/launcherVersion.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { Db } from '../src/db';
import {
    DEFAULT_RATING,
    DEFAULT_RD,
    type RatingMode,
} from '../src/elo/glicko2';
import { effectiveRatings } from '../src/elo/ladder';
import { isInPlacement, placementRequired } from '../src/elo/placement';
import { matchupKey } from '../src/elo/antifarm';
import { rawConsecutiveWins, shortMatchCount } from '../src/elo/alerts';
import { uuid } from '../src/lib/ids';
import { loadConfig, replayStorageFromEnv } from '../src/env';
import { presignObject } from '../src/replays/presign';
import { fetch, type Response as UndiciResponse } from 'undici';
import { KvStore } from '../src/kv';
import type { AppContext } from '../src/context';
import { standingFor } from '../src/stats/standing';
import { highlightsFor, monthOf, previousMonth, renderDiscord } from '../src/stats/highlights';
import { postHighlights } from '../src/stats/highlightsAnnounce';
import * as tourn from './adminTournaments';

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
    /** Which side they played on. 0 for everyone in a 1v1 and in every match stored before the
     *  launcher could work teams out — so it is only interesting when the numbers differ. */
    team: number;
    result: number;
    rating_before: number | null;
    rating_after: number | null;
    display_name: string | null;
    /** What they played, and the deck they brought. Null is the ordinary case for anything
     *  stored before the launcher could resolve them — and, for a long time, for everything.
     *  PRINTED rather than merely selected: this column was missing from every admin command
     *  in this file while 31 of 32 rated matches were arriving with it empty, so nobody could
     *  tell whether the launcher had failed to send it or the server had failed to store it. */
    civ: string | null;
    home_city: string | null;
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
 * <p>Moved to <c>src/elo/replay.ts</c> the day the SERVER needed it too — a founded match
 * contradicted by a later reading is undone by exactly this replay. Re-exported here so the
 * commands and <c>scripts/test-admin.ts</c> keep their import; the rule and its comments live
 * beside the ladder maths now.</p>
 */
import { recomputeLadder } from '../src/elo/replay';
export { recomputeLadder };

interface RatingRow {
    user_id: string;
    rating: number;
    rd: number;
    games_played: number;
    display_name: string | null;
}

/**
 * One ladder, keyed by user id. `default` is the 1v1 ladder and `team` the one 2v2 and 3v3 share.
 * `rd` is as stored (as of the player's last rated match), not grown to now: this is for diffs.
 */
export async function readRatings(
    db: Db,
    mode: RatingMode = 'default',
): Promise<Map<string, RatingRow>> {
    const rows = await db.prepare(
        `SELECT e.user_id, e.rating, e.rd, e.games_played, u.display_name
           FROM player_ratings e LEFT JOIN users u ON u.id = e.user_id
          WHERE e.mode = ?`,
    ).bind(mode).all<RatingRow>();
    const map = new Map<string, RatingRow>();
    for (const r of rows.results ?? []) map.set(r.user_id, r);
    return map;
}

/** Print who moved between two ladders. The empty case is the interesting one for a self-check. */
function printRatingDiff(before: Map<string, RatingRow>, after: Map<string, RatingRow>, top = 0): number {
    const ids = new Set([...before.keys(), ...after.keys()]);
    const rows: Array<{ who: string; rb: number | null; ra: number | null; gb: number | string; ga: number | string }> = [];
    for (const id of [...ids].sort()) {
        const b = before.get(id);
        const a = after.get(id);
        const rb = b?.rating ?? null;
        const ra = a?.rating ?? null;
        if (rb !== null && ra !== null && Math.abs(rb - ra) < 0.0005
            && b!.games_played === a!.games_played) continue;
        rows.push({
            who: a?.display_name ?? b?.display_name ?? id, rb, ra,
            gb: b?.games_played ?? '-', ga: a?.games_played ?? '-',
        });
    }
    // With `top`, the biggest movers first and only that many: a full recompute moves everyone.
    const shown = top > 0
        ? [...rows].sort((x, y) => Math.abs((y.ra ?? 0) - (y.rb ?? 0)) - Math.abs((x.ra ?? 0) - (x.rb ?? 0))).slice(0, top)
        : rows;
    for (const r of shown) {
        console.log(
            `  ${pad(r.who, 22)} ${pad(num(r.rb, 1), 8)} -> ${pad(num(r.ra, 1), 8)}` +
            `  games ${r.gb} -> ${r.ga}`,
        );
    }
    if (top > 0 && rows.length > shown.length) console.log(`  … and ${rows.length - shown.length} more`);
    return rows.length;
}

/** Both ladders, in the order they are printed, under the names an operator uses for them. */
const LADDERS: ReadonlyArray<{ mode: RatingMode; label: string }> = [
    { mode: 'default', label: '1v1 ladder' },
    { mode: 'team', label: 'team ladder' },
];

/** How many players are ranked and how many still being placed, per ladder. */
async function placementCounts(db: Db, mode: RatingMode): Promise<{ ranked: number; placing: number }> {
    const required = placementRequired(mode);
    const row = await db.prepare(
        `SELECT SUM(CASE WHEN games_played >= ? THEN 1 ELSE 0 END) AS ranked,
                SUM(CASE WHEN games_played > 0 AND games_played < ? THEN 1 ELSE 0 END) AS placing
           FROM player_ratings WHERE mode = ?`,
    ).bind(required, required, mode).first<{ ranked: number | null; placing: number | null }>();
    return { ranked: row?.ranked ?? 0, placing: row?.placing ?? 0 };
}

/**
 * Perform a rating-moving change: on a snapshot when this is a dry run, on the real database when
 * it is not. Either way the operator sees the actual movement before or as it happens.
 *
 * <p>`mutate` edits the stored rows and returns true to replay (src/elo/replay.ts rebuilds every
 * rating from the history), or false/null to abort. Both ladders are printed even when nothing
 * moved on one, because "(no rating moved)" is the confirmation that it touched nothing else.
 * `after`, when given, runs on the same database once the replay is done.</p>
 */
async function withRatingChange(
    dbPath: string,
    label: string,
    mutate: (db: Db) => Promise<boolean | null>,
    after?: (db: Db) => Promise<void>,
    opts: { top?: number } = {},
): Promise<void> {
    const run = async (db: Db, real: boolean): Promise<void> => {
        const before = new Map<RatingMode, Map<string, RatingRow>>();
        const countsBefore = new Map<RatingMode, { ranked: number; placing: number }>();
        for (const l of LADDERS) {
            before.set(l.mode, await readRatings(db, l.mode));
            countsBefore.set(l.mode, await placementCounts(db, l.mode));
        }
        const go = await mutate(db);
        if (!go) return;
        const { matches, refunds } = await recomputeLadder(db);

        console.log(`Ladder rebuilt from the history: ${matches} rated match(es), ${refunds} refund line(s).`);
        for (const l of LADDERS) {
            console.log(`${l.label}:`);
            const moved = printRatingDiff(before.get(l.mode) ?? new Map(), await readRatings(db, l.mode), opts.top ?? 0);
            if (moved === 0) console.log('  (no rating moved)');
            const cb = countsBefore.get(l.mode)!;
            const ca = await placementCounts(db, l.mode);
            console.log(`  ranked ${cb.ranked} -> ${ca.ranked}   in placement ${cb.placing} -> ${ca.placing}`);
        }
        const farm = await db.prepare(
            `SELECT COUNT(*) AS n, AVG(elo_factor) AS avg FROM matches WHERE rated = 1 AND elo_factor < 1`,
        ).bind().first<{ n: number; avg: number | null }>();
        console.log(`Anti-farm: ${farm?.n ?? 0} rated match(es) counted for less than 100%`
            + (farm?.avg != null ? ` (average ${Math.round(farm.avg * 100)}%)` : '') + '.');
        if (after) await after(db);
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

/**
 * Which launcher builds are out there, and what a minimum would cost.
 *
 * <p><b>The reason this exists.</b> `MIN_LAUNCHER_VERSION` locks people out of multiplayer, and
 * without this the only way to learn how many is to set it and wait for complaints. The column
 * is written whenever somebody makes an authenticated request, so this is a real picture of who
 * is actually playing rather than of who once registered.</p>
 *
 * <p>Players with no recorded version are counted separately and shown as WOULD BE BLOCKED,
 * because that is exactly how the check treats them: a client that reports nothing can only be a
 * build from before clients reported one.</p>
 */
async function cmdVersions(db: Db): Promise<void> {
    const min = positionals()[0] ?? '';

    const rows = await db.prepare(
        `SELECT COALESCE(u.last_launcher_version, '') AS version, COUNT(*) AS n
           FROM users u
          WHERE EXISTS (SELECT 1 FROM player_ratings e WHERE e.user_id = u.id)
             OR u.last_launcher_version IS NOT NULL
          GROUP BY version
          ORDER BY n DESC`,
    ).bind().all<{ version: string; n: number }>();

    const list = rows.results ?? [];
    if (list.length === 0) { console.log('No players seen yet.'); return; }

    const total = list.reduce((a, r) => a + r.n, 0);
    console.log(`Launcher versions in use (${total} player(s) seen)`);
    for (const r of list) {
        const label = r.version || '(not reported — an older build)';
        console.log(`  ${pad(label, 34)} ${r.n}`);
    }

    if (!min) {
        console.log('');
        console.log('Pass a version to see what requiring it would cost, e.g.:');
        console.log('  admin.ts versions v1.0.14');
        return;
    }

    let blocked = 0;
    for (const r of list) if (!meetsMinimum(r.version, min)) blocked += r.n;

    console.log('');
    console.log(`Requiring ${min} would block ${blocked} of ${total} player(s) from multiplayer.`);
    if (blocked > 0) {
        console.log('They keep single-player, mods and match reporting; only entering a room is refused.');
    }
    console.log('Set it with MIN_LAUNCHER_VERSION in /opt/wol-lobby/.env, then restart the service.');
}

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

    const banned = await db.prepare(
        `SELECT COUNT(*) AS n FROM users WHERE is_banned = 1`,
    ).bind().first<{ n: number }>();

    console.log('Ladders');
    for (const l of LADDERS) {
        const c = await placementCounts(db, l.mode);
        console.log(`  ${pad(l.label, 12)} ranked ${c.ranked}   in placement ${c.placing}`);
    }
    const alerts = await db.prepare(
        `SELECT COUNT(*) AS n FROM admin_alerts WHERE acknowledged_at IS NULL`,
    ).bind().first<{ n: number }>();
    console.log('Players');
    console.log(`  banned ${banned?.n ?? 0}   open alerts ${alerts?.n ?? 0}${(alerts?.n ?? 0) > 0 ? '  (alerts:list)' : ''}`);
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
    competitive: number;
}

async function selectLobbies(db: Db, where: string, params: unknown[]): Promise<LobbyRow[]> {
    const rows = await db.prepare(
        `SELECT l.id, l.host_user_id, l.title, l.status, l.created_at, l.competitive,
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
    console.log(`  ${pad('ID', 10)} ${pad('STATUS', 9)} ${pad('MODE', 5)} ${pad('HOST', 20)} ${pad('AGE', 8)} ${pad('MEM', 4)} TITLE`);
    for (const r of shown) {
        const age = r.age_min >= 60 ? `${Math.floor(r.age_min / 60)}h${r.age_min % 60}m` : `${r.age_min}m`;
        console.log(
            `  ${pad(r.id, 10)} ${pad(r.status, 9)} ${pad(r.competitive === 1 ? 'COMP' : '-', 5)}` +
            ` ${pad(r.host ?? r.host_user_id, 20)}` +
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

    // CIVS is counted here rather than left to match:show, because the question it answers is
    // about the TREND: after a fix that is supposed to make civilizations arrive, the only thing
    // worth looking at is whether new rows still have none. One at a time could never show that,
    // and for weeks nothing in this file printed the column at all.
    const rows = await db.prepare(
        `SELECT m.id, m.mod_id, m.map_name, m.started_at, m.rated, m.unrated_reason,
                m.duration_seconds,
                (SELECT COUNT(*) FROM match_participants p WHERE p.match_id = m.id) AS players,
                (SELECT COUNT(*) FROM match_participants p
                  WHERE p.match_id = m.id
                    AND p.civ IS NOT NULL AND LENGTH(TRIM(p.civ)) > 0) AS with_civ
           FROM matches m
          ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
          ORDER BY m.started_at DESC LIMIT ?`,
    ).bind(...params, limit).all<MatchRow & { players: number; with_civ: number }>();

    const found = rows.results ?? [];
    console.log(`${found.length} match(es).`);
    if (found.length === 0) return;
    console.log(
        `  ${pad('ID', 38)} ${pad('WHEN', 20)} ${pad('MAP', 16)} ${pad('RATED', 6)} `
        + `${pad('CIVS', 6)} REASON`);
    for (const m of found) {
        console.log(
            `  ${pad(m.id, 38)} ${pad(m.started_at, 20)} ${pad(m.map_name, 16)}` +
            ` ${pad(m.rated === 1 ? 'yes' : m.rated === 0 ? 'no' : '?', 6)}` +
            ` ${pad(`${m.with_civ}/${m.players}`, 6)} ${m.unrated_reason ?? ''}`,
        );
    }

    const blind = found.filter((m) => m.rated === 1 && m.with_civ === 0).length;
    if (blind > 0) {
        console.log(
            `\n  ${blind} of the rated match(es) above carry NO civilization. `
            + 'Use match:show <id> to see whether the confirmations carried them.');
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
    {
        const e = await db.prepare(
            `SELECT elo_factor, farm_streak, matchup_key, tournament_match_id, room_teams,
                    COALESCE(rating_mode, 'default') AS mode
               FROM matches WHERE id = ?`,
        ).bind(m.id).first<{
            elo_factor: number | null; farm_streak: number | null; matchup_key: string | null;
            tournament_match_id: string | null; room_teams: string | null; mode: string;
        }>();
        if (e) {
            console.log(`  ladder     ${e.mode === 'team' ? 'team' : '1v1'}`
                + `   factor ${e.elo_factor === null ? '-' : `${Math.round(e.elo_factor * 100)}%`}`
                + `   farm streak ${e.farm_streak ?? '-'}`
                + (e.tournament_match_id ? `   tournament ${e.tournament_match_id}` : ''));
            if (e.matchup_key) console.log(`  matchup    ${e.matchup_key}`);
            if (e.room_teams) console.log(`  room teams ${e.room_teams}`);
        }
        const shared = await db.prepare(
            `SELECT COUNT(*) AS n FROM (
                 SELECT ip_hash FROM match_participants WHERE match_id = ? AND ip_hash IS NOT NULL
                  GROUP BY ip_hash HAVING COUNT(*) > 1)`,
        ).bind(m.id).first<{ n: number }>();
        console.log(`  same IP    ${(shared?.n ?? 0) > 0 ? 'YES — two players shared a network (hash only)' : 'no'}`);
        // The competitive recording in the bucket (migration 0030), if the reporter's launcher
        // uploaded one. `replay_key IS NULL` is "never uploaded" or "expired and forgotten".
        const rec = await db.prepare(
            `SELECT replay_key, replay_size_bytes, replay_uploaded_at, replay_uploader_id
               FROM matches WHERE id = ?`,
        ).bind(m.id).first<{
            replay_key: string | null; replay_size_bytes: number | null;
            replay_uploaded_at: string | null; replay_uploader_id: string | null;
        }>();
        console.log(rec?.replay_key
            ? `  recording  ${rec.replay_key}  (${rec.replay_size_bytes ?? '?'} bytes, `
              + `${rec.replay_uploaded_at ?? '?'}, by ${rec.replay_uploader_id ?? '?'})`
            : '  recording  none');
    }
    if (m.decided_by === 'abandon') {
        console.log('             ^ decided because one player walked out, not by the recording.');
    }

    // The first question anyone asks about a match that did not score. Reading it from the
    // room rather than the match row on purpose: the match never carried the flag, and the
    // room is where the decision was actually made.
    if (m.lobby_id) {
        const room = await db.prepare(
            `SELECT competitive, started_at FROM lobbies WHERE id = ?`,
        ).bind(m.lobby_id).first<{ competitive: number; started_at: string | null }>();
        if (room) {
            console.log(`  room mode  ${room.competitive === 1 ? 'COMPETITIVE' : 'casual (never scores)'}`);
        }
        const abandons = await db.prepare(
            `SELECT a.user_id, a.disconnected_at, u.display_name
               FROM lobby_abandons a LEFT JOIN users u ON u.id = a.user_id
              WHERE a.lobby_id = ?`,
        ).bind(m.lobby_id).all<{
            user_id: string; disconnected_at: string; display_name: string | null;
        }>();
        for (const a of abandons.results ?? []) {
            console.log(`  walked out ${pad(a.display_name ?? a.user_id, 22)} at ${a.disconnected_at}`);
        }

        // The OTHER walkout, and usually the one being disputed: the socket stayed up and the
        // GAME closed. `at` is the server's clock when the frame landed, which is what the
        // verdict used; `said` is the launcher's own count of the match, kept only so a wildly
        // different number gives away a broken clock.
        const exits = await db.prepare(
            `SELECT e.user_id, e.exited_at, e.client_seconds, u.display_name,
                    e.exit_code, e.recording_outcome, e.stopped_by_user, e.crash_verified, e.crash_module
               FROM lobby_game_exits e LEFT JOIN users u ON u.id = e.user_id
              WHERE e.lobby_id = ?`,
        ).bind(m.lobby_id).all<{
            user_id: string; exited_at: string;
            client_seconds: number | null; display_name: string | null;
            exit_code: number | null; recording_outcome: string | null;
            stopped_by_user: number | null; crash_verified: number | null; crash_module: string | null;
        }>();
        for (const e of exits.results ?? []) {
            const said = e.client_seconds === null ? '-' : `${e.client_seconds}s`;
            console.log(`  closed game ${pad(e.display_name ?? e.user_id, 21)} at ${e.exited_at}  (launcher said ${said})`);
            // HOW it closed — the evidence frame (migration 0022). Absent for a launcher older
            // than it. `crash` is the server's own verdict from the four signals.
            if (e.recording_outcome !== null || e.exit_code !== null) {
                const code = e.exit_code === null ? '-' : `0x${(e.exit_code >>> 0).toString(16).toUpperCase()}`;
                console.log(
                    `             exit ${code}  recording ${e.recording_outcome ?? '-'}`
                    + `  stopped-by-user ${e.stopped_by_user ? 'yes' : 'no'}`
                    + `  crash ${e.crash_verified ? `VERIFIED (${e.crash_module ?? '?'})` : 'no'}`);
            }
        }
    }
    console.log(`  seed       ${m.game_seed ?? '-'}   hostTime ${m.game_host_time ?? '-'}`);
    console.log(`  replay     ${m.replay_sha256 ?? '-'}`);

    // Ordered by TEAM first, then result: for a team match this is the only place anybody can
    // see who was on whose side, and "four names sorted by result" answers a different question
    // than the one being asked when a team match is disputed.
    const parts = await db.prepare(
        `SELECT p.match_id, p.user_id, p.team, p.result, p.rating_before, p.rating_after,
                p.civ, p.home_city, u.display_name
           FROM match_participants p LEFT JOIN users u ON u.id = p.user_id
          WHERE p.match_id = ? ORDER BY p.team, p.result DESC`,
    ).bind(id).all<ParticipantRow>();

    const players = parts.results ?? [];
    // Printed only when the sides actually differ, so a 1v1 reads exactly as it always has.
    const showTeams = new Set(players.map((p) => p.team)).size > 1;

    console.log('  participants');
    for (const p of players) {
        console.log(
            `    ${pad(p.display_name ?? p.user_id, 22)}` +
            (showTeams ? ` team ${p.team}` : '') +
            ` result ${p.result}` +
            `   elo ${pad(num(p.rating_before, 1), 8)} -> ${num(p.rating_after, 1)}` +
            // A dash rather than nothing: an absent civilization has to LOOK absent, or the
            // line reads as if the question was never asked.
            `   civ ${pad(p.civ ?? '-', 14)} city ${p.home_city ?? '-'}`,
        );
    }

    if (!m.lobby_id) return;
    const confs = await db.prepare(
        `SELECT c.user_id, c.result, c.agreement, c.same_game, c.game_seed,
                c.civs, c.home_cities, u.display_name
           FROM match_confirmations c LEFT JOIN users u ON u.id = c.user_id
          WHERE c.lobby_id = ?`,
    ).bind(m.lobby_id).all<{
        user_id: string; result: number; agreement: string | null;
        same_game: string | null; game_seed: number | null;
        civs: string | null; home_cities: string | null; display_name: string | null;
    }>();

    const rows = confs.results ?? [];
    console.log(`  confirmations (${rows.length})`);
    for (const c of rows) {
        console.log(
            `    ${pad(c.display_name ?? c.user_id, 22)} said ${c.result}` +
            `   agreement ${pad(c.agreement, 14)} same_game ${pad(c.same_game, 8)} seed ${c.game_seed ?? '-'}` +
            // The count, not the JSON: what is being asked is "did this reading carry the
            // civilizations at all", and a map with a seed and a result beside an empty civ
            // list is the exact signature of the recording parsing and the identity join
            // refusing. The names themselves are on the participant lines above.
            `   civs ${nameMapSize(c.civs)} cities ${nameMapSize(c.home_cities)}`,
        );
    }
}

/**
 * How many players a stored `civs` / `home_cities` map names. `-` when the column is null,
 * which is what a launcher too old to send them leaves behind, and `?` when it holds something
 * that is not a JSON object — worth telling apart from "empty".
 */
function nameMapSize(json: string | null): string {
    if (json === null || json.trim() === '') return '-';
    try {
        const parsed = JSON.parse(json);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '?';
        return String(Object.keys(parsed).length);
    } catch {
        return '?';
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
        if (!m) { console.log(`No match '${id}'.`); return null; }

        const user = await findUser(db, winner);
        if (!user) return null;

        const parts = await db.prepare(
            `SELECT match_id, user_id, result FROM match_participants WHERE match_id = ?`,
        ).bind(id).all<ParticipantRow>();
        const rows = parts.results ?? [];

        if (rows.length !== 2) {
            console.log(
                `Match has ${rows.length} participants — only a 1v1 can be decided here.`
                + (rows.length === 4 || rows.length === 6
                    ? ' For a 2v2 or 3v3 use match:decide-team.' : ''));
            return null;
        }
        if (!rows.some((p) => p.user_id === user.id)) {
            console.log(`${user.display_name} did not play in this match.`);
            return null;
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

/** A player as {@link decideTeamMatch} reports them: the id it wrote, the name an operator reads. */
export interface TeamDecisionPlayer {
    userId: string;
    displayName: string;
}

/** Which rule refused, so a test can tell that the INTENDED rule fired and not an earlier one. */
export type TeamRefusal =
    | 'no_match'
    | 'not_a_team_match'
    | 'named_twice'
    | 'did_not_play'
    | 'wrong_loser_count';

/** What {@link decideTeamMatch} wrote, or why it refused. A refusal has written nothing. */
export type TeamDecision =
    | { ok: false; reason: TeamRefusal; error: string }
    | {
        ok: true;
        matchId: string;
        winners: TeamDecisionPlayer[];
        losers: TeamDecisionPlayer[];
        /** The row as it stood before, so the command can say what it overrode. */
        was: {
            rated: number | null;
            unratedReason: string | null;
            ratingMode: string | null;
            decidedBy: string | null;
        };
    };

/**
 * Turn a stored 2v2 or 3v3 into a rated team match, from a result an operator read off the
 * recordings. Writes the sides, the results and the rating state; the caller replays the
 * ladder.
 *
 * <p><b>Why it exists.</b> A team match whose sides the launcher failed to read arrives with
 * every participant on team 0 and a 0.5, and is stored `not_1v1`: one side, so no shape the
 * server rates. Nothing rates it afterwards. `match:decide` takes 1v1s only, and
 * `maybeRateAwaitingTeamMatch` only releases matches stored `awaiting_confirmation`, whose
 * sides are already known.</p>
 *
 * <p><b>Why the LOSERS are named.</b> A recording names the losing side, and with exactly two
 * sides that decides the other one. So the input is the thing the operator actually read. The
 * winners are everyone else in the match.</p>
 *
 * <p>Team 0 is the winners and team 1 the losers. The numbers mean nothing beyond being
 * different: `applyMatch` only compares them, and `matchShape` counts two equal sides.
 * `rating_mode = 'team'` is what sends the match to the team ladder in the replay; left at
 * 'default', a four-player match would be fed to the 1v1 ladder.</p>
 *
 * <p>Every write happens in one batch, which `Db.batch` runs as one transaction, so it either
 * all lands or none of it does. A refusal reads and nothing else.</p>
 */
export async function decideTeamMatch(
    db: Db,
    matchId: string,
    loserUserIds: readonly string[],
): Promise<TeamDecision> {
    const refuse = (reason: TeamRefusal, error: string): TeamDecision =>
        ({ ok: false, reason, error });

    const m = await db.prepare(
        `SELECT rated, unrated_reason, rating_mode, decided_by FROM matches WHERE id = ?`,
    ).bind(matchId).first<{
        rated: number | null;
        unrated_reason: string | null;
        rating_mode: string | null;
        decided_by: string | null;
    }>();
    if (!m) return refuse('no_match', `No match '${matchId}'.`);

    const parts = await db.prepare(
        `SELECT p.user_id, COALESCE(u.display_name, p.user_id) AS display_name
           FROM match_participants p LEFT JOIN users u ON u.id = p.user_id
          WHERE p.match_id = ?
          ORDER BY p.user_id`,
    ).bind(matchId).all<{ user_id: string; display_name: string }>();
    const players = parts.results ?? [];

    if (players.length !== 4 && players.length !== 6) {
        return refuse('not_a_team_match', players.length === 2
            ? `Match has 2 participants — that is a 1v1; use match:decide.`
            : `Match has ${players.length} participant(s) — only a 2v2 (4) or a 3v3 (6) can be decided here.`);
    }

    const inMatch = new Map(players.map((p) => [p.user_id, p.display_name] as [string, string]));
    const nameOf = async (userId: string): Promise<string> => {
        const known = inMatch.get(userId);
        if (known !== undefined) return known;
        const u = await db.prepare(`SELECT display_name FROM users WHERE id = ?`)
            .bind(userId).first<{ display_name: string }>();
        return u?.display_name ?? userId;
    };

    // Distinct first. Two names for one person (an id and a display name, say) would
    // otherwise count as two losers and pass the count check below.
    const losers = new Set<string>();
    for (const id of loserUserIds) {
        if (losers.has(id)) {
            return refuse('named_twice', `${await nameOf(id)} is named twice among the losers.`);
        }
        losers.add(id);
    }

    const outsiders = [...losers].filter((id) => !inMatch.has(id));
    if (outsiders.length > 0) {
        const names: string[] = [];
        for (const id of outsiders) names.push(await nameOf(id));
        return refuse('did_not_play', `${names.join(', ')} did not play in this match.`);
    }

    const perSide = players.length / 2;
    if (losers.size !== perSide) {
        return refuse('wrong_loser_count',
            `${losers.size} loser(s) named — a ${perSide}v${perSide} needs exactly ${perSide}.`);
    }

    await db.batch([
        db.prepare(
            `UPDATE matches SET rated = 1, unrated_reason = NULL, rating_mode = 'team',
                                decided_by = 'operator'
              WHERE id = ?`,
        ).bind(matchId),
        ...players.map((p) => {
            const lost = losers.has(p.user_id);
            return db.prepare(
                `UPDATE match_participants SET team = ?, result = ? WHERE match_id = ? AND user_id = ?`,
            ).bind(lost ? 1 : 0, lost ? 0.0 : 1.0, matchId, p.user_id);
        }),
    ]);

    const pick = (lost: boolean): TeamDecisionPlayer[] => players
        .filter((p) => losers.has(p.user_id) === lost)
        .map((p) => ({ userId: p.user_id, displayName: p.display_name }));

    return {
        ok: true,
        matchId,
        winners: pick(false),
        losers: pick(true),
        was: {
            rated: m.rated,
            unratedReason: m.unrated_reason,
            ratingMode: m.rating_mode,
            decidedBy: m.decided_by,
        },
    };
}

/**
 * Rate a stored 2v2 or 3v3 by naming its losing side, then replay both ladders. See
 * {@link decideTeamMatch} for the rules. Players are given comma-separated; use the id for
 * anyone whose display name contains a comma.
 */
async function cmdMatchDecideTeam(dbPath: string): Promise<void> {
    const id = positionals()[0];
    const raw = flag('losers');
    if (!id || !raw) {
        console.log('Usage: match:decide-team <matchId> --losers <p1,p2[,p3]> [--apply]');
        return;
    }
    const needles = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);

    await withRatingChange(dbPath, `match ${id} decided as a team match`, async (db) => {
        const loserIds: string[] = [];
        for (const needle of needles) {
            const user = await findUser(db, needle);
            if (!user) return null;   // findUser has already said why.
            loserIds.push(user.id);
        }

        const d = await decideTeamMatch(db, id, loserIds);
        if (!d.ok) { console.log(d.error); return null; }

        const names = (ps: TeamDecisionPlayer[]): string => ps.map((p) => p.displayName).join(', ');
        const was = d.was.unratedReason
            ?? (d.was.rated === 1 ? 'rated' : d.was.rated === 0 ? 'unrated' : 'unknown');
        console.log(`Match ${id}: winners ${names(d.winners)}; losers ${names(d.losers)}; was '${was}'.`);
        return true;
    });
}

async function cmdMatchVoid(dbPath: string): Promise<void> {
    const id = positionals()[0];
    if (!id) { console.log('Usage: match:void <matchId> [--apply]'); return; }

    await withRatingChange(dbPath, `match ${id} voided`, async (db) => {
        const m = await db.prepare(`SELECT * FROM matches WHERE id = ?`).bind(id).first<MatchRow>();
        if (!m) { console.log(`No match '${id}'.`); return null; }

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
 * Rebuild every rating from the match history under the CURRENT rules — Glicko-2 with placement,
 * inactivity decay and anti-farm (src/elo/glicko2.ts, src/elo/ladder.ts) — and every ban refund.
 *
 * <p>This is the command that moves the ladder onto the new rules after a deploy. Dry run by
 * default, on a snapshot: it prints the biggest movers, how many players end up ranked and in
 * placement on each ladder, and how many matches anti-farm discounted. Read that before
 * `--apply`, and stop the service around the apply (DEPLOY.md, "Continuous ladder").</p>
 *
 * <p>Run again with nothing changed, it must move nobody: that is the self-check that the replay
 * reproduces the live ladder.</p>
 */
async function cmdEloRecompute(dbPath: string): Promise<void> {
    if (flag('from-season') !== null) {
        console.log('Note: --from-season is ignored. There are no seasons; the whole history is rebuilt.');
    }
    await withRatingChange(dbPath, 'ladder recomputed', async () => true, undefined, { top: 25 });
}

/** Seasons were removed (migration 0025). Kept so an operator's old notes do not error out. */
function cmdSeasonShow(): void {
    console.log('Seasons were removed: there is one continuous ladder and it never resets.');
    console.log('Use player:show, or the launcher\'s Ranking tab.');
}

async function cmdPlayerShow(db: Db): Promise<void> {
    const needle = positionals()[0];
    if (!needle) { console.log('Usage: player:show <player>'); return; }
    const u = await findUser(db, needle);
    if (!u) return;

    console.log(`${u.display_name}  (${u.discord_username})`);
    console.log(`  id       ${u.id}`);
    console.log(`  banned   ${u.is_banned === 1 ? `yes — ${u.ban_reason ?? 'no reason recorded'}` : 'no'}`);
    const ctx = { db } as unknown as AppContext;
    const now = Date.now();
    for (const l of LADDERS) {
        const st = await standingFor(ctx, u.id, l.mode, now, { self: true });
        const where = st.games_played === 0
            ? `no rated match — counts as ${DEFAULT_RATING}/${DEFAULT_RD}`
            : isInPlacement(st.games_played, l.mode)
                ? `placement ${st.placement_played}/${st.placement_required}`
                : `rank #${st.ladder_rank ?? '?'} of ${st.ladder_size ?? '?'}`;
        console.log(
            `  ${pad(l.label, 12)} ${num(st.rating, 1)}  rd ${num(st.rd, 1)} (now)  games ${st.games_played}  (${where})`
            + (st.inactive ? '  INACTIVE' : ''));
        if (st.games_played > 0) {
            console.log(
                `               W-L ${st.wins}-${st.losses}   streak ${st.streak_current} (best ${st.streak_best},`
                + ` worst ${st.loss_streak_best})   last rated ${st.last_rated_at ?? '-'}`);
            if (st.rating_peak !== null) {
                console.log(`               peak ${num(st.rating_peak, 1)} (${st.rating_peak_at})`
                    + `   low ${num(st.rating_low, 1)} (${st.rating_low_at})`);
            }
        }
    }
    const refunds = await db.prepare(
        `SELECT r.mode, r.points, r.matches, b.created_at, r.seen_at
           FROM rating_refunds r JOIN ban_refunds b ON b.id = r.refund_id
          WHERE r.user_id = ? AND b.revoked_at IS NULL ORDER BY b.created_at DESC`,
    ).bind(u.id).all<{ mode: string; points: number; matches: number; created_at: string; seen_at: string | null }>();
    for (const r of refunds.results ?? []) {
        console.log(`  refund   +${num(r.points, 1)} on ${r.mode === 'team' ? 'team' : '1v1'} for ${r.matches} match(es)`
            + ` (${r.created_at})${r.seen_at ? '' : '  unseen'}`);
    }

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
        `SELECT m.id, m.started_at, m.map_name, m.rated, m.unrated_reason, m.elo_factor,
                p.result, p.rating_before, p.rating_after
           FROM match_participants p JOIN matches m ON m.id = p.match_id
          WHERE p.user_id = ? ORDER BY m.started_at DESC LIMIT ?`,
    ).bind(u.id, limit).all<MatchRow & ParticipantRow & { elo_factor: number | null }>();

    const found = rows.results ?? [];
    console.log(`${found.length} match(es) for ${u.display_name}.`);
    for (const m of found) {
        const verdict = m.result === 1 ? 'win' : m.result === 0 ? 'loss' : 'draw/none';
        const factor = m.elo_factor !== null && m.elo_factor < 1 ? ` ${Math.round(m.elo_factor * 100)}%` : '';
        console.log(
            `  ${pad(m.started_at, 20)} ${pad(m.map_name, 16)} ${pad(verdict, 10)}` +
            ` elo ${pad(num(m.rating_before, 1), 8)} -> ${pad(num(m.rating_after, 1), 8)}${factor}` +
            ` ${m.rated === 1 ? '' : m.unrated_reason ?? 'unrated'}`,
        );
    }
}

async function cmdPlayerReset(dbPath: string): Promise<void> {
    const needle = positionals()[0];
    if (!needle) { console.log('Usage: player:reset <player> [--apply]'); return; }

    // Not routed through withRatingChange: this deliberately does NOT replay history, which
    // would put the rating straight back. It is a manual override, and the next recompute will
    // undo it — which is worth knowing before reaching for it.
    const db = new Db(dbPath);
    try {
        const u = await findUser(db, needle);
        if (!u) return;
        console.log(
            `  ${u.display_name}: 1v1 rating forgotten -> ${DEFAULT_RATING}, rd ${DEFAULT_RD}, games 0 `
            + '(placement again)');
        console.log('Note: this does not erase their matches, so an elo:recompute would undo it.');
        if (APPLY) {
            await db.prepare(
                `DELETE FROM player_ratings WHERE user_id = ? AND mode = 'default'`,
            ).bind(u.id).run();
        }
        summarise(1, 'player');
    } finally {
        db.close();
    }
}

async function cmdPlayerBan(db: Db, ban: boolean): Promise<void> {
    const needle = positionals()[0];
    if (!needle) { console.log(`Usage: player:${ban ? 'ban <player> --reason "..." [--refund]' : 'unban <player> [--revoke-refunds]'} [--apply]`); return; }
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
        console.log('Cheating? Add --refund to give their opponents back what they lost to them.');
    }
    summarise(1, 'player');
}

/** Print what a refund gave, without ever printing who it was for in a player-facing way. */
async function printRefund(db: Db, refundId: string): Promise<void> {
    const rows = await db.prepare(
        `SELECT r.user_id, COALESCE(u.display_name, r.user_id) AS name, r.mode, r.points, r.matches,
                r.rating_before, r.rating_after
           FROM rating_refunds r LEFT JOIN users u ON u.id = r.user_id
          WHERE r.refund_id = ? ORDER BY r.points DESC`,
    ).bind(refundId).all<{
        user_id: string; name: string; mode: string; points: number; matches: number;
        rating_before: number; rating_after: number;
    }>();
    const list = rows.results ?? [];
    console.log(`Refund ${refundId}: ${list.length} player(s).`);
    if (list.length === 0) console.log('  (nobody lost rated points to them)');
    for (const r of list) {
        console.log(`  ${pad(r.name, 22)} ${r.mode === 'team' ? 'team' : '1v1 '}  +${pad(num(r.points, 1), 7)}`
            + ` over ${r.matches} match(es)   ${num(r.rating_before, 1)} -> ${num(r.rating_after, 1)}`);
    }
}

/**
 * Ban a cheater AND give their opponents back the points they lost to them: one refund event on
 * the rating timeline, re-derived by every replay (src/elo/ladder.ts, applyRefund). Each player
 * gets one notice per ladder in the launcher, which never names the banned player.
 */
async function cmdPlayerBanWithRefund(dbPath: string): Promise<void> {
    const needle = positionals()[0];
    if (!needle) { console.log('Usage: player:ban <player> --reason "..." --refund [--refund-since YYYY-MM-DD] [--apply]'); return; }
    const reason = flag('reason');
    const sinceRaw = flag('refund-since');
    let since: string | null = null;
    if (sinceRaw) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceRaw)) { console.log('--refund-since must be YYYY-MM-DD.'); return; }
        since = `${sinceRaw} 00:00:00`;
    }
    let refundId = '';
    await withRatingChange(dbPath, 'player banned and refunds given', async (db) => {
        const u = await findUser(db, needle);
        if (!u) return null;
        if (u.is_banned === 1) {
            const prior = await db.prepare(
                `SELECT 1 FROM ban_refunds WHERE banned_user_id = ? AND revoked_at IS NULL LIMIT 1`,
            ).bind(u.id).first();
            if (prior) { console.log(`${u.display_name} is already banned with a refund.`); return null; }
        }
        console.log(`  ${u.display_name} (${u.discord_username}) -> banned: ${reason ?? 'no reason given'}`
            + `; refunding losses against them${since ? ` since ${sinceRaw}` : ''}`);
        refundId = uuid();
        await db.batch([
            db.prepare(`UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ?`).bind(reason, u.id),
            db.prepare(
                `INSERT INTO ban_refunds (id, banned_user_id, since, reason) VALUES (?, ?, ?, ?)`,
            ).bind(refundId, u.id, since, reason),
        ]);
        return true;
    }, async (db) => printRefund(db, refundId));
}

/** Unban, taking back the refunds the ban gave (the replay recomputes everyone without them). */
async function cmdPlayerUnbanRevoke(dbPath: string): Promise<void> {
    const needle = positionals()[0];
    if (!needle) { console.log('Usage: player:unban <player> --revoke-refunds [--apply]'); return; }
    await withRatingChange(dbPath, 'player unbanned and refunds revoked', async (db) => {
        const u = await findUser(db, needle);
        if (!u) return null;
        const r = await db.prepare(
            `UPDATE ban_refunds SET revoked_at = datetime('now')
              WHERE banned_user_id = ? AND revoked_at IS NULL`,
        ).bind(u.id).run();
        await db.prepare(`UPDATE users SET is_banned = 0, ban_reason = NULL WHERE id = ?`).bind(u.id).run();
        console.log(`  ${u.display_name}: unbanned; ${r.changes} refund(s) revoked.`);
        return true;
    });
}

async function cmdRefundsList(db: Db): Promise<void> {
    const who = flag('player');
    let userFilter: string | null = null;
    if (who) {
        const u = await findUser(db, who);
        if (!u) return;
        userFilter = u.id;
    }
    const refunds = await db.prepare(
        `SELECT b.id, b.created_at, b.since, b.reason, b.revoked_at,
                COALESCE(u.display_name, b.banned_user_id) AS banned
           FROM ban_refunds b LEFT JOIN users u ON u.id = b.banned_user_id
          ORDER BY b.created_at DESC`,
    ).bind().all<{ id: string; created_at: string; since: string | null; reason: string | null;
        revoked_at: string | null; banned: string }>();
    const list = refunds.results ?? [];
    if (list.length === 0) { console.log('No refunds.'); return; }
    for (const r of list) {
        const lines = await db.prepare(
            `SELECT COALESCE(u.display_name, x.user_id) AS name, x.user_id, x.mode, x.points, x.matches, x.seen_at
               FROM rating_refunds x LEFT JOIN users u ON u.id = x.user_id
              WHERE x.refund_id = ? ORDER BY x.points DESC`,
        ).bind(r.id).all<{ name: string; user_id: string; mode: string; points: number; matches: number; seen_at: string | null }>();
        const rows = (lines.results ?? []).filter((x) => userFilter === null || x.user_id === userFilter);
        if (userFilter !== null && rows.length === 0) continue;
        console.log(`${r.id}  ${r.created_at}  banned ${r.banned}${r.revoked_at ? `  REVOKED ${r.revoked_at}` : ''}`
            + `${r.since ? `  since ${r.since}` : ''}  ${r.reason ?? ''}`);
        for (const x of rows) {
            console.log(`  ${pad(x.name, 22)} ${x.mode === 'team' ? 'team' : '1v1 '} +${pad(num(x.points, 1), 7)}`
                + ` over ${x.matches} match(es)${x.seen_at ? '' : '  (unseen)'}`);
        }
    }
}

async function cmdAlertsList(db: Db): Promise<void> {
    const all = ARGV.includes('--all');
    const kind = flag('kind');
    const rows = await db.prepare(
        `SELECT id, kind, matchup_key, user_ids, match_id, value, created_at, last_seen_at, acknowledged_at
           FROM admin_alerts
          WHERE (? = 1 OR acknowledged_at IS NULL) AND (? IS NULL OR kind = ?)
          ORDER BY last_seen_at DESC`,
    ).bind(all ? 1 : 0, kind, kind).all<{
        id: string; kind: string; matchup_key: string; user_ids: string; match_id: string | null;
        value: number; created_at: string; last_seen_at: string; acknowledged_at: string | null;
    }>();
    const list = rows.results ?? [];
    if (list.length === 0) { console.log(all ? 'No alerts.' : 'No open alerts.'); return; }
    for (const a of list) {
        let names = a.user_ids;
        try {
            const ids = JSON.parse(a.user_ids) as string[];
            const out: string[] = [];
            for (const id of ids) {
                const u = await db.prepare(`SELECT display_name FROM users WHERE id = ?`).bind(id)
                    .first<{ display_name: string }>();
                out.push(u?.display_name ?? id);
            }
            names = out.join(', ');
        } catch { /* keep the raw list */ }
        console.log(`${a.id}  ${pad(a.kind, 13)} value ${pad(a.value, 3)} last ${a.last_seen_at}`
            + `${a.acknowledged_at ? `  acked ${a.acknowledged_at}` : ''}`);
        console.log(`  ${names}   last match ${a.match_id ?? '-'}`);
    }
}

async function cmdAlertsAck(db: Db): Promise<void> {
    const id = positionals()[0];
    if (!id) { console.log('Usage: alerts:ack <id> [--apply]'); return; }
    const a = await db.prepare(`SELECT id, acknowledged_at FROM admin_alerts WHERE id = ?`).bind(id)
        .first<{ id: string; acknowledged_at: string | null }>();
    if (!a) { console.log(`No alert '${id}'.`); return; }
    if (a.acknowledged_at) { console.log('Already acknowledged.'); return; }
    if (APPLY) {
        await db.prepare(`UPDATE admin_alerts SET acknowledged_at = datetime('now') WHERE id = ?`).bind(id).run();
    }
    summarise(1, 'alert');
}

/**
 * Look for both alert patterns across the history, without writing anything: pairs with a long
 * raw run of wins by the same side, and pairs with many very short matches in the window.
 */
async function cmdAlertsScan(db: Db): Promise<void> {
    const cfg = loadConfig();
    const days = Number(flag('days') ?? 30);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    const keys = await db.prepare(
        `SELECT DISTINCT matchup_key FROM matches
          WHERE matchup_key IS NOT NULL AND rated = 1 AND created_at >= ?`,
    ).bind(since).all<{ matchup_key: string }>();
    let found = 0;
    for (const { matchup_key: key } of keys.results ?? []) {
        const rows = await db.prepare(
            `SELECT farm_winner_key FROM matches
              WHERE matchup_key = ? AND rated = 1 AND tournament_match_id IS NULL
              ORDER BY created_at DESC, id DESC LIMIT 50`,
        ).bind(key).all<{ farm_winner_key: string | null }>();
        const streak = rawConsecutiveWins((rows.results ?? []).map((r) => r.farm_winner_key));
        if (streak >= cfg.alertFarmStreak) {
            found++;
            console.log(`farm_streak    ${streak} in a row   ${key}`);
        }
    }

    // Very short 1v1s, by pair.
    const pairs = await db.prepare(
        `SELECT a.user_id AS a, b.user_id AS b, m.duration_seconds AS d
           FROM matches m
           JOIN match_participants a ON a.match_id = m.id
           JOIN match_participants b ON b.match_id = m.id AND b.user_id > a.user_id
          WHERE m.created_at >= ?
            AND (SELECT COUNT(*) FROM match_participants x WHERE x.match_id = m.id) = 2`,
    ).bind(since).all<{ a: string; b: string; d: number }>();
    const byPair = new Map<string, number[]>();
    for (const r of pairs.results ?? []) {
        const k = matchupKey('default', [[r.a], [r.b]]);
        const list = byPair.get(k) ?? [];
        list.push(r.d);
        byPair.set(k, list);
    }
    for (const [k, durations] of byPair) {
        const n = shortMatchCount(durations, cfg.newAccountShortMatchSeconds);
        if (n >= cfg.alertShortMatches) {
            found++;
            console.log(`short_matches  ${n} under ${cfg.newAccountShortMatchSeconds}s   ${k}`);
        }
    }
    console.log(found === 0 ? `Nothing found in the last ${days} day(s).` : `${found} pattern(s) found. Nothing was written.`);
}

async function cmdHighlightsShow(db: Db): Promise<void> {
    const month = positionals()[0] ?? previousMonth(monthOf(Date.now()));
    if (!/^\d{4}-\d{2}$/.test(month)) { console.log('Usage: highlights:show [YYYY-MM]'); return; }
    const h = await highlightsFor({ db } as unknown as AppContext, month, Date.now());
    console.log(JSON.stringify(h, null, 2));
    for (const lang of ['es', 'en'] as const) {
        console.log(`\n--- Discord (${lang}) ---`);
        console.log(renderDiscord(h, lang) ?? '(nothing to post: no rated match that month)');
    }
}

/**
 * Post a month's highlights to the highlights webhook now. The server does this on its own early
 * on the 1st; this is for a missed month or a re-post (--force ignores the "already posted" mark).
 */
async function cmdHighlightsPost(dbPath: string): Promise<void> {
    const month = positionals()[0] ?? previousMonth(monthOf(Date.now()));
    if (!/^\d{4}-\d{2}$/.test(month)) { console.log('Usage: highlights:post [YYYY-MM] [--force] [--apply]'); return; }
    const db = new Db(dbPath);
    try {
        const kv = new KvStore(db);
        kv.init();
        const ctx = { db, kv, config: loadConfig() } as unknown as AppContext;
        if (!ARGV.includes('--force') && await kv.get(`highlights:posted:${month}`)) {
            console.log(`${month} was already posted. Use --force to post it again.`);
            return;
        }
        if (ctx.config.discordHighlightsWebhookUrls.length === 0) {
            console.log('No highlights webhook configured (DISCORD_HIGHLIGHTS_WEBHOOK_URL / DISCORD_WEBHOOK_URL).');
            return;
        }
        if (!APPLY) {
            const h = await highlightsFor(ctx, month, Date.now());
            console.log(renderDiscord(h, 'es') ?? '(nothing to post)');
            console.log(`\nWould post to ${ctx.config.discordHighlightsWebhookUrls.length} webhook(s). Re-run with --apply.`);
            return;
        }
        const ok = await postHighlights(ctx, month, undefined, Date.now());
        console.log(ok ? `Posted ${month}.` : `Nothing posted for ${month}.`);
    } finally {
        db.close();
    }
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

// ---------------------------------------------------------------- replay storage

/**
 * Proves the recordings bucket works end to end, with no match and no launcher: PUT a tiny
 * object through a presigned URL (with the size signed, exactly as a launcher uploads), HEAD
 * it, GET it back, DELETE it. Each step prints the status the storage answered, and a failure
 * prints the storage's own error body — `SignatureDoesNotMatch`, `NoSuchBucket`,
 * `NotAuthorizedOrNotFound` name the cause better than anything this script could.
 *
 * Not dry-run like the rest of this file: it writes nothing to the database and leaves
 * nothing in the bucket (the object is deleted at the end, and it lives under `selftest/`).
 */
async function cmdReplaySelftest(): Promise<void> {
    const storage = replayStorageFromEnv();
    if (!storage) {
        console.log('Replay storage is not configured. Set REPLAY_S3_ENDPOINT (https), REPLAY_S3_REGION,');
        console.log('REPLAY_S3_ACCESS_KEY, REPLAY_S3_SECRET_KEY and REPLAY_BUCKET in .env.');
        process.exitCode = 1;
        return;
    }

    const key = `selftest/${uuid()}.txt`;
    const body = Buffer.from(`wol-lobby replay selftest ${new Date().toISOString()}\n`, 'utf8');
    console.log(`Bucket ${storage.bucket} at ${storage.endpoint} (${storage.region})`);
    console.log(`Object ${key} (${body.length} bytes)\n`);

    let ok = true;
    const report = async (label: string, res: UndiciResponse, good: boolean, note = '') => {
        console.log(`  ${pad(label, 8)} ${res.status} ${good ? 'OK' : 'FAILED'}${note ? `  ${note}` : ''}`);
        if (!good) {
            ok = false;
            const text = await res.text().catch(() => '');
            if (text) console.log(`           ${text.slice(0, 500).replace(/\s+/g, ' ')}`);
        }
    };

    try {
        const put = await fetch(presignObject(storage, 'PUT', key, {
            expiresSec: 300,
            signedHeaders: { 'content-length': String(body.length) },
        }), { method: 'PUT', body, headers: { 'content-type': 'application/octet-stream' } });
        await report('PUT', put, put.ok);
        if (!put.ok) return finish(false);

        const head = await fetch(presignObject(storage, 'HEAD', key, { expiresSec: 60 }), { method: 'HEAD' });
        const size = Number(head.headers.get('content-length') ?? '-1');
        await report('HEAD', head, head.ok && size === body.length, `content-length ${size}`);

        const get = await fetch(presignObject(storage, 'GET', key, {
            expiresSec: 60,
            query: { 'response-content-disposition': 'attachment; filename="selftest.txt"' },
        }));
        const got = get.ok ? Buffer.from(await get.arrayBuffer()) : Buffer.alloc(0);
        await report('GET', get, get.ok && got.equals(body),
            `same bytes: ${got.equals(body) ? 'yes' : 'no'}; disposition: ${get.headers.get('content-disposition') ?? '-'}`);

        const del = await fetch(presignObject(storage, 'DELETE', key, { expiresSec: 60 }), { method: 'DELETE' });
        await report('DELETE', del, del.ok || del.status === 204);
    } catch (err) {
        console.log(`  network error: ${(err as Error).message}`);
        ok = false;
    }
    finish(ok);

    function finish(success: boolean): void {
        console.log(success
            ? '\nThe bucket accepts uploads, serves downloads and deletes. Recordings will work.'
            : '\nSomething failed — the storage error above names the cause.');
        if (!success) process.exitCode = 1;
    }
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
  match:decide-team <id> --losers <a,b[,c]>
                                            rate a stored 2v2/3v3 from its recordings by
                                            naming the losing side, then replay both ladders
  match:void <id>                           stop it counting, then replay the ladder
  elo:recompute                             rebuild every rating from the history under the
                                            current rules (dry run prints who moves)
  player:show <player>                      rating, placement, streaks, ban state, memberships
  player:history <player> [--limit N]
  player:reset <player>                     forget one player's 1v1 rating (back to ${DEFAULT_RATING})
  player:ban <player> --reason "..." [--refund [--refund-since YYYY-MM-DD]]
                                            ban; --refund gives his opponents back what they
                                            lost to him (one notice each, never naming him)
  player:unban <player> [--revoke-refunds]
  player:unstick <player>                   clear rows that bar them from every room
  refunds:list [--player <p>]               refunds given, and to whom
  alerts:list [--all] [--kind K]            open operator alerts (farm streaks, short matches)
  alerts:ack <id>                           close one
  alerts:scan [--days 30]                   look for both patterns in the history; writes nothing
  highlights:show [YYYY-MM]                 a month's highlights and its Discord text
  highlights:post [YYYY-MM] [--force]       post them to the highlights webhook
  replay:selftest                           upload, read and delete a tiny test object in the
                                            recordings bucket (REPLAY_S3_*); touches no database
  season:show                               (seasons were removed; kept so old notes still run)

${tourn.TOURNAMENT_USAGE}

A player is matched by id, Discord username or display name.
The database is the positional path, else DB_PATH, else ./lobby.db.`);
}

/** The small slice of this file's plumbing the tournament commands need. */
function cli(): tourn.CliCtx {
    return { apply: APPLY, positionals: positionals(), flag, pad };
}

// ---------------------------------------------------------------- main

/** Every command name, so an unknown one is refused before any database is opened. */
const KNOWN = new Set([
    'status',
    'rooms:list', 'rooms:close', 'rooms:prune',
    'match:list', 'match:show', 'match:decide', 'match:decide-team', 'match:void',
    'elo:recompute', 'season:show',
    'player:show', 'player:history', 'player:reset',
    'versions',
    'player:ban', 'player:unban', 'player:unstick',
    'refunds:list', 'alerts:list', 'alerts:ack', 'alerts:scan',
    'highlights:show', 'highlights:post',
    'replay:selftest',
    ...tourn.TOURNAMENT_COMMANDS,
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

    // Talks to the bucket only, never to a database — answered before one is opened.
    if (COMMAND === 'replay:selftest') return cmdReplaySelftest();

    const dbPath = resolveDbPath();

    // The rating commands manage their own connection: a dry run has to open a snapshot
    // instead of the real database, and that decision belongs to them.
    if (COMMAND === 'match:decide') return cmdMatchDecide(dbPath);
    if (COMMAND === 'match:decide-team') return cmdMatchDecideTeam(dbPath);
    if (COMMAND === 'match:void') return cmdMatchVoid(dbPath);
    if (COMMAND === 'elo:recompute') return cmdEloRecompute(dbPath);
    if (COMMAND === 'player:reset') return cmdPlayerReset(dbPath);
    if (COMMAND === 'player:ban' && ARGV.includes('--refund')) return cmdPlayerBanWithRefund(dbPath);
    if (COMMAND === 'player:unban' && ARGV.includes('--revoke-refunds')) return cmdPlayerUnbanRevoke(dbPath);
    if (COMMAND === 'highlights:post') return cmdHighlightsPost(dbPath);

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
            case 'versions': return await cmdVersions(db);
            case 'season:show': return cmdSeasonShow();
            case 'refunds:list': return await cmdRefundsList(db);
            case 'alerts:list': return await cmdAlertsList(db);
            case 'alerts:ack': return await cmdAlertsAck(db);
            case 'alerts:scan': return await cmdAlertsScan(db);
            case 'highlights:show': return await cmdHighlightsShow(db);

            // Tournaments and teams. The maintainer inspects and overrules; creating,
            // seeding and starting belong to whoever owns the tournament.
            case 'tournament:list': return await tourn.cmdTournamentList(db, cli());
            case 'tournament:show': return await tourn.cmdTournamentShow(db, cli());
            case 'tournament:void': return await tourn.cmdTournamentVoid(db, cli());
            case 'tournament:cancel': return await tourn.cmdTournamentCancel(db, cli());
            case 'tournament:feature': return await tourn.cmdTournamentFeature(db, cli());
            case 'tournament:reap': return await tourn.cmdTournamentReap(db, cli());
            case 'team:show': return await tourn.cmdTeamShow(db, cli());
            case 'team:disband': return await tourn.cmdTeamDisband(db, cli());
            case 'tournament:transfer':
                return await tourn.cmdTournamentTransfer(db, cli(), (n) => findUser(db, n));
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
