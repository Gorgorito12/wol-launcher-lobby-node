/**
 * Decide matches that were stored WITHOUT a result but whose other player had already sent
 * a readable one — retroactively, for matches played before the correction path existed.
 *
 * Run: `npx tsx scripts/upgrade-pending.ts` (dry run — lists what it WOULD do)
 *      `npx tsx scripts/upgrade-pending.ts --apply`
 *      `npx tsx scripts/upgrade-pending.ts /path/to/lobby.db --apply`
 *
 * Why this exists. Until now only the host's reading of their own recording could decide a
 * match, so one whose host could not read theirs stayed unrated forever — even when the
 * other player's recording named the winner and their client had faithfully sent it, where
 * it was filed as evidence and ignored. Those confirmations are still in the database. This
 * pairs them with the rule that now governs live matches and settles the backlog.
 *
 * A SCRIPT and not a migration, for the same reason as reset-elo.ts and one more: it changes
 * history rows that people have already seen. That is an operator's decision to take
 * deliberately, not something a service restart should do on its own.
 *
 * DRY RUN BY DEFAULT. It prints every match it would decide, who decided it and why, and
 * writes nothing until `--apply`.
 *
 * <p><b>It cannot re-rate a match that already scored.</b> Eligibility is
 * `unrated_reason = 'no_decided_result'`, a column written only by the code that now stores
 * the verdict — so every row from before that migration is NULL and inelegible by
 * construction. Ratings move once or not at all.</p>
 */
import 'dotenv/config';
import { Db } from '../src/db';
import { canUpgradeFromConfirmation, WIN_AT } from '../src/elo/ratability';
import { applyMatch, type ParticipantOutcome } from '../src/elo/glicko2';

function resolveDbPath(): string {
    const positional = process.argv.slice(2).find((a) => !a.startsWith('--'));
    return positional || process.env.DB_PATH || './lobby.db';
}

interface PendingMatch {
    id: string;
    lobby_id: string | null;
    unrated_reason: string | null;
    game_seed: number | null;
    game_host_time: number | null;
}

function parseRoster(json: string | null): Set<string> | null {
    if (!json) return null;
    try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) ? new Set(parsed.filter((v) => typeof v === 'string')) : null;
    } catch {
        return null;
    }
}

async function main(): Promise<void> {
    const apply = process.argv.includes('--apply');
    const db = new Db(resolveDbPath());

    const pending = await db.prepare(
        `SELECT id, lobby_id, unrated_reason, game_seed, game_host_time
         FROM matches WHERE unrated_reason = 'no_decided_result' AND lobby_id IS NOT NULL
         ORDER BY created_at ASC`,
    ).bind().all<PendingMatch>();

    const rows = pending.results ?? [];
    console.log(`${rows.length} undecided match(es) with a room.`);
    let decided = 0;

    for (const match of rows) {
        const lobbyId = match.lobby_id!;

        const players = (await db.prepare(
            `SELECT user_id FROM match_participants WHERE match_id = ?`,
        ).bind(match.id).all<{ user_id: string }>()).results ?? [];
        if (players.length !== 2) continue;

        const roster = await db.prepare(
            `SELECT roster_at_start FROM lobbies WHERE id = ?`,
        ).bind(lobbyId).first<{ roster_at_start: string | null }>();
        const frozen = parseRoster(roster?.roster_at_start ?? null);

        const confirmations = (await db.prepare(
            `SELECT user_id, result, game_seed, game_host_time
             FROM match_confirmations WHERE lobby_id = ?`,
        ).bind(lobbyId).all<{
            user_id: string; result: number; game_seed: number | null; game_host_time: number | null;
        }>()).results ?? [];

        for (const row of confirmations) {
            if (!players.some((p) => p.user_id === row.user_id)) continue;

            let fingerprintAlreadyUsed = false;
            if (match.game_seed === null && row.game_seed !== null && row.game_host_time !== null) {
                const clash = await db.prepare(
                    `SELECT 1 FROM matches WHERE game_seed = ? AND game_host_time = ? AND id <> ? LIMIT 1`,
                ).bind(row.game_seed, row.game_host_time, match.id).first();
                fingerprintAlreadyUsed = !!clash;
            }

            const decision = canUpgradeFromConfirmation({
                storedReason: match.unrated_reason,
                storedSeed: match.game_seed,
                storedHostTime: match.game_host_time,
                confirmResult: row.result,
                confirmSeed: row.game_seed,
                confirmHostTime: row.game_host_time,
                confirmerInRoster: frozen !== null && frozen.has(row.user_id),
                fingerprintAlreadyUsed,
            });
            if (!decision.ok) continue;

            // Narrowed to 0 | 1, same as the live path. NOTE: tsconfig's `include` is
            // `src/**` only, so nothing here is ever type-checked — tsx strips types without
            // checking them. This exact line WOULD be a build error if scripts/ were added to
            // the include, which is reason enough to keep it honest.
            const ownResult: 0 | 1 = row.result >= WIN_AT ? 1 : 0;
            const outcomes: ParticipantOutcome[] = players.map((p) => ({
                userId: p.user_id,
                result: p.user_id === row.user_id ? ownResult : ((1 - ownResult) as 0 | 1),
            }));

            console.log(
                `  ${match.id}: decided by ${row.user_id} (${decision.reason}) — ` +
                outcomes.map((o) => `${o.userId}=${o.result}`).join(' '),
            );
            decided++;

            if (!apply) break;

            const claim = await db.prepare(
                `UPDATE matches SET unrated_reason = NULL, rated = 1, decided_by = ?
                 WHERE id = ? AND unrated_reason = 'no_decided_result'`,
            ).bind(row.user_id, match.id).run();
            if (!claim.changes) break;

            await db.batch(outcomes.map((o) => db.prepare(
                `UPDATE match_participants SET result = ? WHERE match_id = ? AND user_id = ?`,
            ).bind(o.result, match.id, o.userId)));

            if (decision.adoptFingerprint) {
                try {
                    await db.prepare(
                        `UPDATE matches SET game_seed = ?, game_host_time = ? WHERE id = ?`,
                    ).bind(row.game_seed, row.game_host_time, match.id).run();
                } catch {
                    // A bonus, not a requirement — see the live path for why.
                }
            }

            const diff = await applyMatch(db, outcomes);
            const stamps = [];
            for (const o of outcomes) {
                const d = diff.get(o.userId);
                if (!d) continue;
                stamps.push(db.prepare(
                    `UPDATE match_participants SET rating_before = ?, rating_after = ?
                     WHERE match_id = ? AND user_id = ?`,
                ).bind(d.before, d.after, match.id, o.userId));
            }
            if (stamps.length) await db.batch(stamps);
            break;
        }
    }

    console.log(
        decided === 0
            ? 'Nothing to decide.'
            : apply
                ? `Decided ${decided} match(es).`
                : `${decided} match(es) would be decided. Re-run with --apply to write.`,
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
