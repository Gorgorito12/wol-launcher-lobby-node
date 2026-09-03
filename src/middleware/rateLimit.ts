import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { Errors } from '../lib/errors';
import type { AppContext } from '../context';

/**
 * Sliding-bucket rate limiter, ported from the Worker. Each rule has a
 * per-minute and per-day cap; both share a single KV key prefix scoped
 * to (rule, identity kind, identity value). Buckets auto-expire so
 * there's no cron — the next request just sees a fresh window.
 *
 * Self-hosted notes vs the original:
 *   * No more KV-write sampling. The Worker version skipped 4 of every
 *     5 bumps to stay under Cloudflare's 1k-writes-per-day free-tier
 *     ceiling. SQLite has no such cap on a local VM, so we bump every
 *     request and the per-minute / per-day numbers become exact.
 *   * The peer-IP read comes from <c>x-forwarded-for</c> first
 *     (nginx prepends it) and falls back to the socket's remote
 *     address — that way the limits attribute correctly to the real
 *     client when sitting behind the reverse proxy.
 */
export interface RateLimitRule {
    scope: string;
    perMinute: number;
    perDay: number;
    keyKind: 'ip' | 'user';
}

interface CheckResult {
    allowed: boolean;
    retryAfter: number;
}

const MINUTE_SECONDS = 60;
const DAY_SECONDS = 24 * 60 * 60;

export async function checkAndBump(
    ctx: AppContext,
    rule: RateLimitRule,
    keyValue: string,
): Promise<CheckResult> {
    const now = Math.floor(Date.now() / 1000);
    const minuteBucket = Math.floor(now / MINUTE_SECONDS);
    const dayBucket = Math.floor(now / DAY_SECONDS);

    const minuteKey = `rl:${rule.scope}:${rule.keyKind}:${keyValue}:m:${minuteBucket}`;
    const dayKey = `rl:${rule.scope}:${rule.keyKind}:${keyValue}:d:${dayBucket}`;

    const [minuteRaw, dayRaw] = await Promise.all([
        ctx.kv.get(minuteKey),
        ctx.kv.get(dayKey),
    ]);
    const minuteCount = parseInt(minuteRaw || '0', 10) || 0;
    const dayCount = parseInt(dayRaw || '0', 10) || 0;

    if (minuteCount >= rule.perMinute) {
        return { allowed: false, retryAfter: MINUTE_SECONDS - (now % MINUTE_SECONDS) };
    }
    if (dayCount >= rule.perDay) {
        return { allowed: false, retryAfter: DAY_SECONDS - (now % DAY_SECONDS) };
    }

    await Promise.all([
        ctx.kv.put(minuteKey, String(minuteCount + 1), { expirationTtl: MINUTE_SECONDS + 5 }),
        ctx.kv.put(dayKey, String(dayCount + 1), { expirationTtl: DAY_SECONDS + 60 }),
    ]);
    return { allowed: true, retryAfter: 0 };
}

function clientIp(req: FastifyRequest): string {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
        const raw = Array.isArray(xff) ? xff[0]! : xff;
        // x-forwarded-for can be a comma-separated chain when the
        // request bounced through multiple proxies. The first entry
        // is the original client.
        return raw.split(',')[0]!.trim();
    }
    return req.ip || 'unknown';
}

/** preHandler that bumps a per-IP counter and rejects when over cap. */
export function ipRateLimit(ctx: AppContext, rule: RateLimitRule): preHandlerHookHandler {
    return async (req, reply) => {
        if (ctx.config.devAuthBypass) return;
        const ip = clientIp(req);
        const r = await checkAndBump(ctx, rule, ip);
        if (!r.allowed) {
            reply.header('Retry-After', String(r.retryAfter));
            throw Errors.RateLimited(r.retryAfter);
        }
    };
}

/** preHandler that bumps a per-user counter (falls back to IP when anonymous). */
export function userRateLimit(ctx: AppContext, rule: RateLimitRule): preHandlerHookHandler {
    return async (req, reply) => {
        if (ctx.config.devAuthBypass) return;
        const id = req.userId ?? `ip-fallback:${clientIp(req)}`;
        const r = await checkAndBump(ctx, rule, id);
        if (!r.allowed) {
            reply.header('Retry-After', String(r.retryAfter));
            throw Errors.RateLimited(r.retryAfter);
        }
    };
}

/**
 * Canonical rules — copied from the Worker so the limits stay the same
 * for end users. If you tune one, tune it here, not at the call site.
 */
export const Limits = {
    CatchAllIp:       { scope: 'all',       keyKind: 'ip',   perMinute: 120, perDay: 15000 } as const,
    AuthDeviceIp:     { scope: 'authd',     keyKind: 'ip',   perMinute: 5,   perDay: 30   } as const,
    AuthPollIp:       { scope: 'authp',     keyKind: 'ip',   perMinute: 60,  perDay: 500  } as const,
    AuthIp:           { scope: 'auth',      keyKind: 'ip',   perMinute: 60,  perDay: 500  } as const,
    LobbyCreateIp:    { scope: 'lcreate',   keyKind: 'ip',   perMinute: 20,  perDay: 200  } as const,
    LobbyJoinIp:      { scope: 'ljoin',     keyKind: 'ip',   perMinute: 20,  perDay: 200  } as const,
    LobbyListIp:      { scope: 'llist',     keyKind: 'ip',   perMinute: 120, perDay: 15000 } as const,
    ChatIp:           { scope: 'chat',      keyKind: 'ip',   perMinute: 30,  perDay: 500  } as const,
    StatsIp:          { scope: 'stats',     keyKind: 'ip',   perMinute: 20,  perDay: 500  } as const,
    // Public community stats (leaderboard + activity). Its OWN scope rather than a
    // share of StatsIp: those 20/min are already spent by /matches/elo and
    // /matches/history, and behind one Radmin NAT eight players opening the
    // Multiplayer tab at once would let two decorative cards starve the profile of
    // its budget. Cached for a minute server-side, so this ceiling is never reached
    // by honest use anyway.
    StatsPublicIp:    { scope: 'statsp',    keyKind: 'ip',   perMinute: 30,  perDay: 2000 } as const,
    // Civilization balance. Its OWN scope for the same reason StatsPublicIp has one: the
    // community strip already polls /stats/community once a minute while the tab is focused,
    // which is most of that 2000/day from a single launcher, and behind one Radmin NAT two
    // machines share the count. A table nobody has open must not be able to starve the one
    // everybody does. Fetched lazily and cached a minute on both sides, so this ceiling is
    // never reached by honest use either.
    StatsCivsIp:      { scope: 'statsc',    keyKind: 'ip',   perMinute: 20,  perDay: 600  } as const,
    // Its own scope, not shared with the civ table beside it: same reasoning as that one, a
    // rarely-opened table must not be able to spend the budget the busy surface needs from
    // behind a shared Radmin NAT.
    StatsMatchupsIp:  { scope: 'statsm',    keyKind: 'ip',   perMinute: 20,  perDay: 600  } as const,
    StatsDecksIp:     { scope: 'statsd',    keyKind: 'ip',   perMinute: 20,  perDay: 600  } as const,
    // Keyed by USER, not IP: two players behind one Radmin NAT each upload their own decks,
    // and an IP budget would make the second one's silently fail. Deliberately tiny — the
    // launcher uploads once a session, and there is no reason for a legitimate client to
    // send this more than a handful of times a day.
    StatsDeckUpload:  { scope: 'deckup',    keyKind: 'user', perMinute: 3,   perDay: 40   } as const,
    // Public tournament reads. Its own scope for the same reason StatsPublicIp has one:
    // the lists and brackets are opened by people who are ALSO on the profile and the
    // rooms list, and behind one Radmin NAT they all share the count. Memoised a minute
    // on both sides, so this ceiling is never reached by honest use.
    TournamentsIp:    { scope: 'tourn',     keyKind: 'ip',   perMinute: 30,  perDay: 2000 } as const,
    // Registering, withdrawing, seeding, starting. Keyed by USER and not by IP, the same
    // decision as StatsDeckUpload: two players behind one Radmin NAT each enter their own
    // tournaments, and an IP budget would make the second silently fail.
    TournamentWriteUser: { scope: 'tourn-u', keyKind: 'user', perMinute: 10, perDay: 100 } as const,
    // Creating one is the expensive, abusable action — anybody signed in may do it, and
    // there is no moderator. Deliberately tiny; the per-user and server-wide caps in
    // tournaments/rest.ts are the real limit, this only slows a script down.
    TournamentCreateUser: { scope: 'tourn-new', keyKind: 'user', perMinute: 2, perDay: 10 } as const,
    // Team upkeep: creating, inviting, answering, leaving. By USER, like every other
    // write here, because two people behind one Radmin NAT each run their own team.
    TeamInviteUser:   { scope: 'team-u',   keyKind: 'user', perMinute: 10,  perDay: 60   } as const,
    LobbyCreateUser:  { scope: 'lcreate-u', keyKind: 'user', perMinute: 10,  perDay: 100  } as const,
    LobbyJoinUser:    { scope: 'ljoin-u',   keyKind: 'user', perMinute: 50,  perDay: 200  } as const,
    ReportUser:       { scope: 'report-u',  keyKind: 'user', perMinute: 5,   perDay: 20   } as const,
} satisfies Record<string, RateLimitRule>;
