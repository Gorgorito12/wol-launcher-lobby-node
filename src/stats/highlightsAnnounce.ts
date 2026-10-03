/**
 * Post the previous month's highlights to Discord, once, early on the 1st — WITHOUT a timer.
 *
 * <p>This server has no periodic jobs by house rule (src/tournaments/lifecycle.ts says why), so
 * the post is lazy: it is attempted at startup, after every reported match and whenever the
 * community stats are recomputed, and it does something only when ALL of these hold:</p>
 * <ul>
 *   <li>a highlights webhook is configured;</li>
 *   <li>we are within {@link Config.highlightsPostWindowDays} days after a month ended (a server
 *       that was down for the whole window never posts a stale month weeks late);</li>
 *   <li>that month ended AFTER migration 0029 ran (deploying in October never posts September out
 *       of nowhere — same idiom as founding's epoch);</li>
 *   <li>`highlights:posted:YYYY-MM` is not set in kv;</li>
 *   <li>this call wins `highlights:lock:YYYY-MM` (10 minutes), so two triggers in the same second
 *       post once. A failed post leaves the lock to expire, which is the retry back-off.</li>
 * </ul>
 * <p>Never throws.</p>
 */
import { fetch } from 'undici';
import type { FastifyBaseLogger } from 'fastify';
import type { AppContext } from '../context';
import { sqliteTimestampToMs } from '../lib/time';
import { highlightsFor, monthBounds, monthOf, previousMonth, renderDiscord } from './highlights';

const EPOCH_MIGRATION = '0029_monthly_highlights.sql';
const LOCK_TTL_SECONDS = 10 * 60;

let epochMs: number | null | undefined;
/** Months this process already handled (posted or decided not to): no kv round trip again. */
const handled = new Set<string>();

async function epoch(ctx: AppContext): Promise<number> {
    if (epochMs === undefined) {
        try {
            const row = await ctx.db.prepare(
                `SELECT applied_at FROM _migrations WHERE filename = ?`,
            ).bind(EPOCH_MIGRATION).first<{ applied_at: string }>();
            epochMs = sqliteTimestampToMs(row?.applied_at ?? null);
        } catch {
            epochMs = null;
        }
    }
    // A missing row refuses everything: the safe direction.
    return epochMs ?? Date.now();
}

/** Which month (if any) is due for posting at `nowMs`. Pure. */
export function dueMonth(nowMs: number, epochAtMs: number, windowDays: number): string | null {
    const ended = previousMonth(monthOf(nowMs));
    const b = monthBounds(ended);
    if (b.endMs <= epochAtMs) return null;
    if (nowMs - b.endMs > windowDays * 24 * 60 * 60 * 1000) return null;
    return ended;
}

export async function maybePostMonthlyHighlights(
    ctx: AppContext,
    log: FastifyBaseLogger | undefined,
    nowMs: number = Date.now(),
): Promise<void> {
    try {
        const urls = ctx.config.discordHighlightsWebhookUrls;
        if (!urls || urls.length === 0) return;
        const month = dueMonth(nowMs, await epoch(ctx), ctx.config.highlightsPostWindowDays);
        if (!month || handled.has(month)) return;
        if (await ctx.kv.get(`highlights:posted:${month}`)) { handled.add(month); return; }

        // Claim: only the first caller within the lock's lifetime gets past here.
        const lockKey = `highlights:lock:${month}`;
        if (await ctx.kv.get(lockKey)) return;
        await ctx.kv.put(lockKey, '1', { expirationTtl: LOCK_TTL_SECONDS });

        if (await postHighlights(ctx, month, log, nowMs)) handled.add(month);
    } catch (err) {
        log?.info({ err: String(err) }, 'monthly highlights check failed');
    }
}

/**
 * Post one month's highlights to every highlights webhook, now, and mark the month posted. Shared
 * by the lazy trigger above and by `admin.ts highlights:post`. Returns whether the month is now
 * done (posted, or nothing to say).
 */
export async function postHighlights(
    ctx: AppContext,
    month: string,
    log: FastifyBaseLogger | undefined,
    nowMs: number,
): Promise<boolean> {
    const urls = ctx.config.discordHighlightsWebhookUrls;
    const h = await highlightsFor(ctx, month, nowMs);
    const langs: Array<'es' | 'en'> = ctx.config.discordHighlightsLang === 'both'
        ? ['es', 'en'] : [ctx.config.discordHighlightsLang === 'en' ? 'en' : 'es'];
    const text = langs.map((l) => renderDiscord(h, l)).filter((t): t is string => !!t).join('\n\n');
    if (!text) {
        // Nothing was played: nothing to say, and nothing to retry.
        await ctx.kv.put(`highlights:posted:${month}`, 'empty');
        return true;
    }
    let ok = 0;
    for (const url of urls) {
        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                // No pings, ever: the names come from players' own display names.
                body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
            });
            if (resp.ok) ok += 1;
            else log?.warn({ status: resp.status, month }, 'monthly highlights post failed');
        } catch (err) {
            log?.warn({ err: String(err), month }, 'monthly highlights post threw');
        }
    }
    if (ok === 0) return false;
    await ctx.kv.put(`highlights:posted:${month}`, new Date(nowMs).toISOString());
    log?.info({ month, webhooks: ok }, 'monthly highlights posted');
    return true;
}
