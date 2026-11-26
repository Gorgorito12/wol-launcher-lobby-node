/**
 * Achievements over REST (design 121 in the launcher repo).
 *
 * <p>`GET /users/:userId/achievements?mod=<key>` — one game's medals, with progress. Public like
 * the rest of a profile; a private rating hides them from everybody but their owner. Never a 404
 * for an unknown player (he simply has nothing), so a 404 here means "a server without
 * achievements", which is how the launcher knows to hide the section.</p>
 *
 * <p>`POST /me/achievements/seen` — the launcher showed these medals' celebration. Only ever the
 * caller's own rows. With no items, every unseen medal of his.</p>
 *
 * <p>A player reading his OWN medals is evaluated first, so a medal the hooks missed (a timer lost
 * to a restart, a route that settles a tournament without finishing it) arrives on his next look
 * at worst, in `unseen`, with its celebration.</p>
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { Errors } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { ipRateLimit, userRateLimit, Limits } from '../middleware/rateLimit';
import { isRatingPrivate } from '../elo/ratingPrivacy';
import { modKeyOf } from './catalog';
import { evaluate, modsOf } from './evaluate';
import { evaluateAndAward, listEarned, loadEvalInput, markSeen } from './store';
import { buildPayload } from './payload';

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function registerAchievementsRest(app: FastifyInstance, ctx: AppContext): void {
    app.get('/users/:userId/achievements', {
        preHandler: [ipRateLimit(ctx, Limits.AchievementsIp)],
    }, async (req, reply) => {
        const { userId } = req.params as { userId: string };
        if (!USER_ID.test(userId)) throw Errors.BadRequest('Unknown player.');
        const self = req.userId === userId;
        const q = req.query as { mod?: unknown } | undefined;
        const asked = typeof q?.mod === 'string' ? modKeyOf(q.mod.slice(0, 64)) : '';

        const ratingPrivate = isRatingPrivate(userId);
        if (ratingPrivate && !self) {
            return buildPayload({ modKey: asked || 'wol', mods: [], progress: undefined, earned: [], self, ratingPrivate });
        }

        let progress;
        let mods: string[];
        if (self) {
            const r = await evaluateAndAward(ctx, userId);
            progress = r.progress;
            mods = [...progress.keys()];
        } else {
            const input = await loadEvalInput(ctx.db, userId, Date.now());
            progress = evaluate(input);
            mods = modsOf(input);
        }
        const earned = await listEarned(ctx.db, userId);
        const modKey = asked || mods[0] || earned[0]?.mod_key || 'wol';
        if (self) void reply.header('Cache-Control', 'private, no-store');
        return buildPayload({ modKey, mods, progress: progress.get(modKey), earned, self, ratingPrivate });
    });

    app.post('/me/achievements/seen', {
        preHandler: [requireAuth(), userRateLimit(ctx, Limits.AchievementsSeenUser)],
    }, async (req) => {
        const body = (req.body ?? {}) as { items?: unknown };
        const items = Array.isArray(body.items)
            ? (body.items as unknown[])
                .filter((x): x is { mod: string; id: string; tier: number } =>
                    !!x && typeof x === 'object'
                    && typeof (x as { mod?: unknown }).mod === 'string'
                    && typeof (x as { id?: unknown }).id === 'string'
                    && Number.isInteger((x as { tier?: unknown }).tier))
                .slice(0, 50)
            : undefined;
        await markSeen(ctx.db, req.userId!, items);
        return { ok: true };
    });
}
