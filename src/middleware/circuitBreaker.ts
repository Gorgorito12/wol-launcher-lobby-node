import type { preHandlerHookHandler } from 'fastify';
import { Errors } from '../lib/errors.js';
import type { AppContext } from '../context.js';

/**
 * Daily-budget circuit breaker. Preserved here from the original
 * Worker design even though the self-hosted VM doesn't have a hard
 * platform quota — it's still useful as a backpressure valve when
 * something starts hammering the service, and it gives operators a
 * single knob to throttle traffic during a backend incident.
 *
 *   < dailyDegradeThreshold     → green, all routes serve
 *   degraded ≤ count < hardLimit → only safe-read routes serve, writes get 503
 *   ≥ dailyHardLimit            → everything 503 until midnight UTC
 *
 * "Safe-read" is opt-in: a route tags itself with the <c>safeRead</c>
 * preHandler before this one runs.
 */
const COUNTER_PREFIX = 'global:daily:';
const DAY_SECONDS = 24 * 60 * 60;

function dayKey(): string {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export async function readGlobalCount(ctx: AppContext): Promise<number> {
    const raw = await ctx.kv.get(`${COUNTER_PREFIX}${dayKey()}`);
    return parseInt(raw || '0', 10) || 0;
}

export function circuitBreaker(ctx: AppContext): preHandlerHookHandler {
    return async (req, _reply) => {
        const cfg = ctx.config;
        const key = `${COUNTER_PREFIX}${dayKey()}`;
        const current = await readGlobalCount(ctx);

        if (current >= cfg.dailyHardLimit) {
            throw Errors.QuotaExhausted();
        }
        if (current >= cfg.dailyDegradeThreshold && !req.safeRead) {
            throw Errors.QuotaDegraded();
        }

        // Fire-and-forget bump. expirationTtl matches a full day plus
        // 10 min slack so a clock skew at midnight doesn't leak a
        // stale counter into the next day.
        void ctx.kv.put(key, String(current + 1), { expirationTtl: DAY_SECONDS + 600 });
    };
}
