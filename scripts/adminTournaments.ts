/**
 * The maintainer's tournament commands, split out of `admin.ts` to keep that file
 * readable rather than because they are different in kind.
 *
 * ---------------------------------------------------------------------------
 * What is here and what deliberately is not
 * ---------------------------------------------------------------------------
 * Tournaments are created and run from the launcher by whoever made them. The maintainer
 * does not create them, does not seed them and does not start them — that would be
 * exactly the delegation the ownership model exists to avoid.
 *
 * What is here is the LAST WORD: inspect anything, cancel anything, undo a played result,
 * hand a tournament to somebody else when its owner disappears, and archive the dead ones
 * without waiting for a restart. `tournament:void` is the one power the owner does not
 * have, on purpose: undoing a match a recording decided touches the anti-cheat story, so
 * it lives where a dry run and a snapshot exist.
 *
 * ---------------------------------------------------------------------------
 * The thing to say out loud in the output
 * ---------------------------------------------------------------------------
 * Voiding a bracket match does NOT un-rate the game. They are two different decisions and
 * conflating them is the mistake this tool should stop somebody making at 2am, so every
 * void prints the match id and the `match:void` command that would follow.
 */
import type { Db } from '../src/db';
import { voidMatch, type BracketMatch } from '../src/tournaments/bracket';
import {
    getTournament, listEntrants, loadRosters, loadBracket,
    applyMatchUpdates, openLobbiesForTournament,
} from '../src/tournaments/store';
import { staleWhereClause, isStale } from '../src/tournaments/lifecycle';

export interface CliCtx {
    apply: boolean;
    positionals: string[];
    flag: (name: string) => string | null;
    pad: (s: unknown, w: number) => string;
}

// ---------------------------------------------------------------- listing

export async function cmdTournamentList(db: Db, cli: CliCtx): Promise<void> {
    const all = cli.flag('all') !== null || process.argv.includes('--all');
    const rows = await db.prepare(
        `SELECT t.id, t.name, t.status, t.format, t.owner_user_id, t.capacity,
                t.confirmed_count, t.created_at, t.last_activity_at,
                u.display_name AS owner_name
           FROM tournaments t JOIN users u ON u.id = t.owner_user_id
          ORDER BY t.last_activity_at DESC
          LIMIT 100`,
    ).bind().all<{
        id: string; name: string; status: string; format: string; owner_user_id: string;
        capacity: number; confirmed_count: number; created_at: string;
        last_activity_at: string; owner_name: string;
    }>();

    const now = Date.now();
    const list = (rows.results ?? []).filter((r) =>
        all || !isStale({ status: r.status as never, createdAt: r.created_at, lastActivityAt: r.last_activity_at }, now));

    if (list.length === 0) { console.log('No tournaments.'); return; }
    console.log(`${cli.pad('ID', 10)}${cli.pad('STATUS', 14)}${cli.pad('FMT', 6)}${cli.pad('PLACES', 8)}${cli.pad('OWNER', 20)}NAME`);
    for (const r of list) {
        const stale = isStale(
            { status: r.status as never, createdAt: r.created_at, lastActivityAt: r.last_activity_at }, now);
        console.log(
            cli.pad(r.id, 10) + cli.pad(r.status + (stale ? ' (stale)' : ''), 14)
            + cli.pad(r.format, 6) + cli.pad(`${r.confirmed_count}/${r.capacity}`, 8)
            + cli.pad(r.owner_name, 20) + r.name);
    }
    if (!all) console.log('\nStale ones are hidden. Add --all to see them.');
}

export async function cmdTournamentShow(db: Db, cli: CliCtx): Promise<void> {
    const id = cli.positionals[0];
    if (!id) { console.log('Usage: tournament:show <id>'); return; }

    const t = await getTournament(db, id);
    if (!t) { console.log(`No tournament '${id}'.`); return; }

    console.log(`${t.name}   [${t.id}]`);
    console.log(`  status    ${t.status}   format ${t.format}   entry ${t.entry_mode}   source ${t.team_source}`);
    console.log(`  owner     ${t.owner_user_id}`);
    console.log(`  places    ${t.confirmed_count}/${t.capacity}`);
    console.log(`  activity  ${t.last_activity_at}   created ${t.created_at}`);
    if (t.winner_entrant_id) console.log(`  WINNER    ${t.winner_entrant_id}`);

    const entrants = await listEntrants(db, id);
    const rosters = await loadRosters(db, id);
    console.log(`\n  entrants (${entrants.length}):`);
    for (const e of entrants) {
        const roster = (rosters.get(e.id) ?? []).join(', ');
        console.log(`    ${cli.pad(e.seed ?? '-', 4)}${cli.pad(e.status, 14)}${cli.pad(e.display_name, 22)}${roster}`);
    }

    const bracket = await loadBracket(db, id);
    if (bracket.length === 0) { console.log('\n  bracket not drawn yet.'); return; }

    const nameOf = (eid: string | null) =>
        eid ? entrants.find((x) => x.id === eid)?.display_name ?? eid.slice(0, 8) : 'TBD';

    console.log('\n  bracket:');
    const rounds = [...new Set(bracket.map((m) => m.round))].sort((a, b) => a - b);
    for (const r of rounds) {
        console.log(`   round ${r}`);
        for (const m of bracket.filter((x) => x.round === r).sort((a, b) => a.position - b.position)) {
            const outcome = m.status === 'done'
                ? `-> ${nameOf(m.winnerEntrantId)} (${m.outcome})`
                : m.status === 'bye' ? `-> ${nameOf(m.winnerEntrantId)} (bye)` : '';
            // The match id is what every other command takes, so it has to be printed.
            console.log(`    ${m.id}  R${m.round}#${m.position}  ${nameOf(m.entrant1Id)} vs ${nameOf(m.entrant2Id)}  ${outcome}`);
        }
    }
}

// ---------------------------------------------------------------- corrections

export async function cmdTournamentVoid(db: Db, cli: CliCtx): Promise<void> {
    const [id, mid] = cli.positionals;
    if (!id || !mid) { console.log('Usage: tournament:void <id> <matchId> [--cascade]'); return; }
    const cascade = process.argv.includes('--cascade');

    const bracket = await loadBracket(db, id);
    if (bracket.length === 0) { console.log(`No bracket for '${id}'.`); return; }

    const target = bracket.find((m) => m.id === mid);
    if (!target) { console.log(`No match '${mid}' in that tournament.`); return; }

    const result = voidMatch(bracket, mid, cascade);
    if (!result.ok) {
        console.log(`Refused: ${result.reason}.`);
        if (result.reason === 'next_round_decided') {
            console.log('The next round is already settled. Add --cascade to undo it too.');
        }
        return;
    }

    const entrants = await listEntrants(db, id);
    const nameOf = (eid: string | null) =>
        eid ? entrants.find((x) => x.id === eid)?.display_name ?? eid.slice(0, 8) : 'TBD';

    console.log(`Would clear ${result.updates.length} bracket row(s):`);
    for (const u of result.updates) {
        const m = bracket.find((x) => x.id === u.id)!;
        console.log(`  R${m.round}#${m.position}  ${nameOf(m.entrant1Id)} vs ${nameOf(m.entrant2Id)}`
            + (m.winnerEntrantId ? `  (was: ${nameOf(m.winnerEntrantId)})` : ''));
    }

    // THE THING TO SAY OUT LOUD. Two different decisions, and conflating them is the
    // mistake this output exists to prevent.
    const played = await db.prepare(
        `SELECT match_id FROM tournament_matches WHERE id = ? AND match_id IS NOT NULL`,
    ).bind(mid).first<{ match_id: string }>();
    if (played) {
        console.log(`\nNOTE: the game ${played.match_id} still counts towards the ladder.`);
        console.log(`      Undoing the bracket does not un-rate it. If it should not count:`);
        console.log(`          npm run admin -- match:void ${played.match_id} --apply`);
    }

    if (!cli.apply) { console.log('\nRe-run with --apply to write.'); return; }

    await applyMatchUpdates(db, result.updates);
    await db.prepare(
        `UPDATE tournament_matches SET match_id = NULL, decided_by = NULL, decided_at = NULL
          WHERE id IN (${result.updates.map(() => '?').join(',')})`,
    ).bind(...result.updates.map((u) => u.id)).run();
    await db.prepare(
        `DELETE FROM tournament_match_games WHERE tournament_match_id = ?`,
    ).bind(mid).run();
    // A finished tournament with a voided final is running again.
    await db.prepare(
        `UPDATE tournaments SET status = 'running', finished_at = NULL, winner_entrant_id = NULL,
                                last_activity_at = datetime('now')
          WHERE id = ? AND status = 'finished'`,
    ).bind(id).run();
    console.log(`Done — ${result.updates.length} bracket row(s) cleared.`);
}

export async function cmdTournamentCancel(db: Db, cli: CliCtx): Promise<void> {
    const id = cli.positionals[0];
    if (!id) { console.log('Usage: tournament:cancel <id>'); return; }
    const t = await getTournament(db, id);
    if (!t) { console.log(`No tournament '${id}'.`); return; }
    if (['finished', 'cancelled', 'abandoned'].includes(t.status)) {
        console.log(`Already ${t.status}.`); return;
    }

    const rooms = await openLobbiesForTournament(db, id);
    console.log(`Would cancel '${t.name}' (${t.status}) and close ${rooms.length} bound room(s).`);
    if (!cli.apply) { console.log('Re-run with --apply to write.'); return; }

    await db.prepare(
        `UPDATE tournaments SET status='cancelled', cancelled_at=datetime('now'),
                                last_activity_at=datetime('now') WHERE id = ?`,
    ).bind(id).run();
    for (const lobbyId of rooms) {
        await db.batch([
            db.prepare(`UPDATE lobbies SET status='closed', closed_at=datetime('now') WHERE id = ?`).bind(lobbyId),
            db.prepare(`DELETE FROM lobby_members WHERE lobby_id = ?`).bind(lobbyId),
        ]);
    }
    // The sockets belong to the running service, which this script is not part of.
    console.log(`Done. Rooms are closed in the database; their sockets drop on the next restart.`);
}

/**
 * Hand a tournament to somebody else.
 *
 * The escape hatch for the one thing ownership cannot solve on its own: the owner
 * disappears mid-bracket and nobody else can seed, award or cancel it. Rare enough to be a
 * command rather than a feature, and deliberately not something the owner can do — a
 * tournament you can give away is a tournament somebody can be talked into giving away.
 */
export async function cmdTournamentTransfer(db: Db, cli: CliCtx, resolveUser: (needle: string) => Promise<{ id: string; display_name: string } | null>): Promise<void> {
    const id = cli.positionals[0];
    const to = cli.flag('to');
    if (!id || !to) { console.log('Usage: tournament:transfer <id> --to <player>'); return; }

    const t = await getTournament(db, id);
    if (!t) { console.log(`No tournament '${id}'.`); return; }
    const u = await resolveUser(to);
    if (!u) return;

    console.log(`Would hand '${t.name}' from ${t.owner_user_id} to ${u.display_name} (${u.id}).`);
    if (!cli.apply) { console.log('Re-run with --apply to write.'); return; }
    await db.prepare(
        `UPDATE tournaments SET owner_user_id = ?, last_activity_at = datetime('now') WHERE id = ?`,
    ).bind(u.id, id).run();
    console.log('Done.');
}

/**
 * Feature a tournament so it may be announced to Discord.
 *
 * The only path to a role ping. A user-created tournament never announces itself, because
 * with anybody able to create one the ping is the obvious thing to abuse.
 */
export async function cmdTournamentFeature(db: Db, cli: CliCtx): Promise<void> {
    const id = cli.positionals[0];
    if (!id) { console.log('Usage: tournament:feature <id> [--off]'); return; }
    const off = process.argv.includes('--off');
    const t = await getTournament(db, id);
    if (!t) { console.log(`No tournament '${id}'.`); return; }

    console.log(`Would ${off ? 'un-feature' : 'feature'} '${t.name}'.`);
    if (!cli.apply) { console.log('Re-run with --apply to write.'); return; }
    await db.prepare(`UPDATE tournaments SET featured = ? WHERE id = ?`).bind(off ? 0 : 1, id).run();
    console.log('Done.');
}

/**
 * Archive stale tournaments now, instead of waiting for the next restart.
 *
 * The service does this once at boot. Running it by hand is for when somebody asks why a
 * dead tournament still shows in `tournament:list` — the readers already ignore it, this
 * only makes the stored status agree.
 */
export async function cmdTournamentReap(db: Db, cli: CliCtx): Promise<void> {
    const rows = await db.prepare(
        `SELECT t.id, t.name, t.status, t.last_activity_at
           FROM tournaments t WHERE ${staleWhereClause('t')}`,
    ).bind().all<{ id: string; name: string; status: string; last_activity_at: string }>();
    const list = rows.results ?? [];

    if (list.length === 0) { console.log('Nothing to archive.'); return; }
    console.log(`${list.length} tournament(s) would be archived:`);
    for (const r of list) console.log(`  ${cli.pad(r.id, 10)}${cli.pad(r.status, 14)}${cli.pad(r.last_activity_at, 22)}${r.name}`);
    console.log('\nArchiving crowns nobody and moves no rating; it only frees the slot.');
    if (!cli.apply) { console.log('Re-run with --apply to write.'); return; }

    await db.batch(list.map((r) => db.prepare(
        `UPDATE tournaments SET status='abandoned', abandoned_at=datetime('now') WHERE id = ?`,
    ).bind(r.id)));
    console.log(`Done — ${list.length} archived.`);
}

// ---------------------------------------------------------------- teams

export async function cmdTeamShow(db: Db, cli: CliCtx): Promise<void> {
    const needle = cli.positionals[0];
    if (!needle) { console.log('Usage: team:show <teamId>'); return; }
    const t = await db.prepare(`SELECT * FROM teams WHERE id = ?`).bind(needle)
        .first<{ id: string; name: string; tag: string | null; owner_user_id: string; disbanded_at: string | null }>();
    if (!t) { console.log(`No team '${needle}'.`); return; }

    console.log(`${t.name}${t.tag ? ` [${t.tag}]` : ''}   ${t.id}${t.disbanded_at ? '   DISBANDED' : ''}`);
    const members = await db.prepare(
        `SELECT m.user_id, m.role, u.display_name FROM team_members m
           JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY m.role = 'captain' DESC`,
    ).bind(t.id).all<{ user_id: string; role: string; display_name: string }>();
    for (const m of members.results ?? []) {
        console.log(`  ${cli.pad(m.role, 10)}${cli.pad(m.display_name, 22)}${m.user_id}`);
    }
}

export async function cmdTeamDisband(db: Db, cli: CliCtx): Promise<void> {
    const id = cli.positionals[0];
    if (!id) { console.log('Usage: team:disband <teamId>'); return; }
    const t = await db.prepare(`SELECT name, disbanded_at FROM teams WHERE id = ?`).bind(id)
        .first<{ name: string; disbanded_at: string | null }>();
    if (!t) { console.log(`No team '${id}'.`); return; }
    if (t.disbanded_at) { console.log('Already disbanded.'); return; }

    console.log(`Would disband '${t.name}'.`);
    console.log('Soft delete: tournaments it already entered keep their frozen rosters.');
    if (!cli.apply) { console.log('Re-run with --apply to write.'); return; }
    await db.prepare(
        `UPDATE teams SET disbanded_at = datetime('now') WHERE id = ?`,
    ).bind(id).run();
    console.log('Done.');
}

/** Names for `admin.ts`'s KNOWN set, so an unknown command is refused before opening a db. */
export const TOURNAMENT_COMMANDS = [
    'tournament:list', 'tournament:show', 'tournament:void', 'tournament:cancel',
    'tournament:transfer', 'tournament:feature', 'tournament:reap',
    'team:show', 'team:disband',
] as const;

export const TOURNAMENT_USAGE = `
  tournament:list [--all]                   tournaments; --all includes the stale ones
  tournament:show <id>                      entrants, seeds and the bracket with match ids
  tournament:void <id> <matchId> [--cascade] undo a bracket result (NOT the ladder)
  tournament:cancel <id>                    cancel it and close its rooms
  tournament:transfer <id> --to <player>    hand it over when the owner has vanished
  tournament:feature <id> [--off]           allow the Discord announcement
  tournament:reap                           archive the stale ones without a restart
  team:show <teamId>                        |  team:disband <teamId>`;

export type { BracketMatch };
