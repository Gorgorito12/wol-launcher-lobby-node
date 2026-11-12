/**
 * Alerts for the operator: things the rating rules soften but a human should look at.
 *
 * <ul>
 *   <li><b>farm_streak</b>: one side has beaten the same opponent (the exact same matchup in a team
 *       game) {@link Config.alertFarmStreak} times in a row or more. Counted RAW — without the
 *       anti-farm rule's daily recovery — because someone farming one win a day is never slowed by
 *       the factor, and this is what catches them.</li>
 *   <li><b>short_matches</b>: the same pair has played {@link Config.alertShortMatches} or more very
 *       short matches (under `NEW_ACCOUNT_SHORT_MATCH_SECONDS`) within the last
 *       `ALERT_SHORT_WINDOW_DAYS` days, rated or not.</li>
 * </ul>
 *
 * <p>Raised when a match is stored — the server has no timers — and kept OPEN in `admin_alerts`
 * (one per kind and matchup) until `admin.ts alerts:ack`. Each new alert is logged at warn level
 * and, when `DISCORD_ADMIN_WEBHOOK_URL` is set, posted there once. Nothing here changes a rating:
 * the decisions stay with the rules and the operator.</p>
 */
import { fetch } from 'undici';
import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context';
import { uuid } from '../lib/ids';
import { toSqliteText } from '../lib/time';
import { matchupKey } from './antifarm';
import { sidesOf } from './ladder';

/** How many wins in a row by the same side, from the newest match backwards. Pure. */
export function rawConsecutiveWins(winnerKeysNewestFirst: readonly (string | null)[]): number {
    const first = winnerKeysNewestFirst[0];
    if (!first) return 0;
    let n = 0;
    for (const k of winnerKeysNewestFirst) {
        if (k !== first) break;
        n += 1;
    }
    return n;
}

/** How many of these durations count as very short. Pure. */
export function shortMatchCount(durations: readonly number[], shortSeconds: number): number {
    return durations.filter((d) => d >= 0 && d < shortSeconds).length;
}

export type AlertKind = 'farm_streak' | 'short_matches';

async function raise(
    ctx: AppContext,
    log: FastifyBaseLogger | undefined,
    kind: AlertKind,
    key: string,
    userIds: readonly string[],
    matchId: string,
    value: number,
): Promise<void> {
    const open = await ctx.db.prepare(
        `SELECT id FROM admin_alerts WHERE kind = ? AND matchup_key = ? AND acknowledged_at IS NULL`,
    ).bind(kind, key).first<{ id: string }>();
    if (open) {
        await ctx.db.prepare(
            `UPDATE admin_alerts SET value = ?, match_id = ?, last_seen_at = datetime('now') WHERE id = ?`,
        ).bind(value, matchId, open.id).run();
        return;
    }
    const id = uuid();
    await ctx.db.prepare(
        `INSERT INTO admin_alerts (id, kind, matchup_key, user_ids, match_id, value)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(id, kind, key, JSON.stringify(userIds), matchId, value).run();
    log?.warn({ alert: kind, matchup: key, users: userIds, value, match_id: matchId },
        'admin alert raised — see admin.ts alerts:list');

    const url = ctx.config.discordAdminWebhookUrl;
    if (url) {
        const what = kind === 'farm_streak'
            ? `${value} wins in a row by the same side`
            : `${value} very short matches`;
        try {
            await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    content: `⚠️ Rating alert (${kind}): ${what} — matchup \`${key}\`, match \`${matchId}\`. `
                        + `Review with \`admin.ts alerts:list\`.`,
                    allowed_mentions: { parse: [] },
                }),
            });
        } catch {
            // best-effort
        }
    }
}

/**
 * Look at the pair behind one stored match and raise what applies. Never throws, never blocks a
 * report (the callers do not await it).
 */
export async function checkPairAlerts(
    ctx: AppContext,
    log: FastifyBaseLogger | undefined,
    matchId: string,
): Promise<void> {
    try {
        const m = await ctx.db.prepare(
            `SELECT rating_mode, matchup_key FROM matches WHERE id = ?`,
        ).bind(matchId).first<{ rating_mode: string | null; matchup_key: string | null }>();
        if (!m) return;
        const mode = m.rating_mode === 'team' ? 'team' : 'default';
        const parts = await ctx.db.prepare(
            `SELECT user_id, team, result FROM match_participants WHERE match_id = ? ORDER BY user_id`,
        ).bind(matchId).all<{ user_id: string; team: number; result: number }>();
        const sides = sidesOf(parts.results ?? [], mode);
        if (!sides) return;
        const key = m.matchup_key ?? matchupKey(mode, sides.map((s) => s.map((p) => p.user_id)));
        const userIds = sides.flat().map((p) => p.user_id);

        // Wins in a row, raw, over the rated non-tournament matches of this exact matchup.
        const recent = await ctx.db.prepare(
            `SELECT farm_winner_key FROM matches
              WHERE matchup_key = ? AND rated = 1 AND tournament_match_id IS NULL
              ORDER BY created_at DESC, id DESC
              LIMIT 50`,
        ).bind(key).all<{ farm_winner_key: string | null }>();
        const streak = rawConsecutiveWins((recent.results ?? []).map((r) => r.farm_winner_key));
        if (streak >= ctx.config.alertFarmStreak) {
            await raise(ctx, log, 'farm_streak', key, userIds, matchId, streak);
        }

        // Very short matches of this pair in the window, rated or not. A 1v1 is found by its two
        // players; a team game by its stored matchup (set only once it rated).
        const since = toSqliteText(Date.now() - ctx.config.alertShortWindowDays * 24 * 60 * 60 * 1000);
        let durations: number[] = [];
        if (mode === 'default' && userIds.length === 2) {
            const rows = await ctx.db.prepare(
                `SELECT m.duration_seconds AS d FROM matches m
                   JOIN match_participants a ON a.match_id = m.id AND a.user_id = ?
                   JOIN match_participants b ON b.match_id = m.id AND b.user_id = ?
                  WHERE m.created_at >= ?
                    AND (SELECT COUNT(*) FROM match_participants x WHERE x.match_id = m.id) = 2`,
            ).bind(userIds[0], userIds[1], since).all<{ d: number }>();
            durations = (rows.results ?? []).map((r) => r.d);
        } else {
            const rows = await ctx.db.prepare(
                `SELECT duration_seconds AS d FROM matches WHERE matchup_key = ? AND created_at >= ?`,
            ).bind(key, since).all<{ d: number }>();
            durations = (rows.results ?? []).map((r) => r.d);
        }
        const shorts = shortMatchCount(durations, ctx.config.newAccountShortMatchSeconds);
        if (shorts >= ctx.config.alertShortMatches) {
            await raise(ctx, log, 'short_matches', key, userIds, matchId, shorts);
        }
    } catch (err) {
        log?.info({ match_id: matchId, err: String(err) }, 'pair alert check failed');
    }
}
