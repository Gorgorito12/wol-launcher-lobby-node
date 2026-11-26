/**
 * The maintainer's achievements commands (src/achievements).
 *
 * `achievements:backfill [--mod K]` — the one-time pass over the history when achievements
 * arrive: every player is evaluated and what he already earned is written ALREADY SEEN, so the
 * deploy does not throw a dozen celebrations at anybody. The dry run prints how many of each
 * medal it would give and, just as important, every civilization and map name in the history
 * the catalogue does not know: a name missing from catalog.ts is a medal nobody can earn.
 *
 * `achievements:revoke <player> <mod> <id> [--tier N]` — take one medal back. The row stays with
 * revoked_at set, which is what stops the next evaluation from handing it back.
 *
 * The age and podium medals are judged from the ladder as it stands NOW: no rank history is
 * stored, so the backfill can only give the place a player holds the day it runs.
 */
import type { Db } from '../src/db';
import type { AppContext } from '../src/context';
import type { CliCtx } from './adminTournaments';
import { allOf, civKey, mapKey, CIV_LISTS, MAP_LISTS, TAD_FAMILIES, TAD_KEY } from '../src/achievements/catalog';
import { evaluate } from '../src/achievements/evaluate';
import { awardNew, loadEvalInput, loadPosition, revoke, achievementsEpochMs } from '../src/achievements/store';
import { isCountable } from '../src/achievements/rules';

export const ACHIEVEMENT_COMMANDS = ['achievements:backfill', 'achievements:revoke'] as const;

export async function cmdAchievementsBackfill(ctx: AppContext, cli: CliCtx): Promise<void> {
    const db = ctx.db;
    const onlyMod = cli.flag('mod')?.trim().toLowerCase() || null;
    const users = await db.prepare(
        `SELECT DISTINCT user_id AS id FROM match_participants
         UNION SELECT DISTINCT created_by FROM lobbies WHERE created_by IS NOT NULL
         UNION SELECT DISTINCT owner_user_id FROM tournaments WHERE status = 'finished'`,
    ).bind().all<{ id: string | null }>();

    const perMedal = new Map<string, number>();
    const unknownCivs = new Map<string, Map<string, number>>();
    const unknownMaps = new Map<string, Map<string, number>>();
    const knownCivs = (mod: string): Set<string> => mod === TAD_KEY
        ? new Set([...TAD_FAMILIES.european, ...TAD_FAMILIES.native, ...TAD_FAMILIES.asian])
        : new Set(CIV_LISTS[mod] ?? []);
    const knownMaps = (mod: string): Set<string> | null => mod === TAD_KEY
        ? new Set([...MAP_LISTS.tad_asian, ...MAP_LISTS.tad_americas]) : null;
    const tally = (bag: Map<string, Map<string, number>>, mod: string, name: string) => {
        const m = bag.get(mod) ?? new Map<string, number>();
        m.set(name, (m.get(name) ?? 0) + 1);
        bag.set(mod, m);
    };

    let players = 0;
    let written = 0;
    const epoch = await achievementsEpochMs(db);
    for (const u of users.results ?? []) {
        if (!u.id) continue;
        players++;
        const input = await loadEvalInput(db, u.id, Date.now(), await loadPosition(ctx, u.id));
        for (const m of input.matches) {
            if (onlyMod && m.modKey !== onlyMod) continue;
            if (!isCountable(m)) continue;
            const civs = knownCivs(m.modKey);
            if (civs.size > 0 && m.civ && !civs.has(civKey(m.civ))) tally(unknownCivs, m.modKey, m.civ);
            const maps = knownMaps(m.modKey);
            if (maps && m.mapName && !maps.has(mapKey(m.mapName))) tally(unknownMaps, m.modKey, m.mapName);
        }
        const progress = evaluate(input);
        if (onlyMod) for (const k of [...progress.keys()]) if (k !== onlyMod) progress.delete(k);
        for (const [mod, items] of progress) {
            for (const item of items.values()) {
                for (const e of item.earned) {
                    const key = `${mod}  ${item.def.id}${e.tier ? `#${e.tier}` : ''}`;
                    perMedal.set(key, (perMedal.get(key) ?? 0) + 1);
                }
            }
        }
        if (cli.apply) written += (await awardNew(db, u.id, progress, { bornSeen: true, epochMs: epoch })).length;
    }

    console.log(`Players evaluated: ${players}`);
    console.log('Medals the history satisfies (already written ones included):');
    for (const [k, n] of [...perMedal.entries()].sort()) console.log(`  ${cli.pad(k, 48)} ${n}`);
    const printUnknown = (title: string, bag: Map<string, Map<string, number>>) => {
        if (bag.size === 0) return;
        console.log(title);
        for (const [mod, names] of bag) {
            for (const [name, n] of [...names.entries()].sort((a, b) => b[1] - a[1])) {
                console.log(`  ${cli.pad(mod, 16)} ${cli.pad(name, 32)} ${n}`);
            }
        }
    };
    printUnknown('Civilizations the catalogue does not know (add them to catalog.ts or they earn nothing):', unknownCivs);
    printUnknown('Maps the catalogue does not know (only the lists of TAD are checked):', unknownMaps);
    console.log(cli.apply
        ? `Done — ${written} medal(s) written, all marked seen.`
        : 'Nothing written. Re-run with --apply to write them (marked seen).');
}

export async function cmdAchievementsRevoke(db: Db, cli: CliCtx, findUserId: (needle: string) => Promise<string | null>): Promise<void> {
    const [player, mod, id] = cli.positionals;
    if (!player || !mod || !id) {
        console.log('Usage: achievements:revoke <player> <mod> <achievement id> [--tier N]');
        return;
    }
    const userId = await findUserId(player);
    if (!userId) return;
    if (!allOf(mod.toLowerCase()).some((a) => a.id === id)) {
        console.log(`'${id}' is not an achievement of '${mod}'.`);
        return;
    }
    const tier = Number(cli.flag('tier') ?? '0');
    if (!Number.isInteger(tier) || tier < 0) { console.log('--tier must be a whole number.'); return; }
    const row = await db.prepare(
        `SELECT earned_at, revoked_at FROM player_achievements
          WHERE user_id = ? AND mod_key = ? AND achievement_id = ? AND tier = ?`,
    ).bind(userId, mod.toLowerCase(), id, tier).first<{ earned_at: string; revoked_at: string | null }>();
    if (!row) { console.log('He does not have that medal.'); return; }
    if (row.revoked_at) { console.log(`Already revoked on ${row.revoked_at}.`); return; }
    console.log(`  ${userId}  ${mod}  ${id}${tier ? `#${tier}` : ''}  earned ${row.earned_at}`);
    if (cli.apply) {
        await revoke(db, userId, mod, id, tier);
        console.log('Done — revoked. It will not be awarded again.');
    } else {
        console.log('Would revoke it. Re-run with --apply.');
    }
}
