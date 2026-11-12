/**
 * GET /matchmaking/status and GET /matchmaking/searchers.
 *
 * Public reads. `status` is also how a launcher learns the server HAS a queue: a 404 here means
 * an older server, and the launcher keeps its room-based quick match (launcher repo,
 * docs/DISENO-PARTIDA-RAPIDA.md §7.5). The live list rides the global socket
 * (`mm_searchers_changed`); `searchers` is for the first paint and for a launcher whose socket
 * is not up yet.
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context';
import { ipRateLimit, Limits } from '../middleware/rateLimit';

export function registerMatchmakingRest(app: FastifyInstance, ctx: AppContext): void {
    app.get('/matchmaking/status', {
        preHandler: [ipRateLimit(ctx, Limits.LobbyListIp)],
    }, async (_req, reply) => {
        reply.header('Cache-Control', 'public, max-age=10');
        return { enabled: !!ctx.matchmaker, queues: ctx.matchmaker?.queues() ?? [] };
    });

    app.get('/matchmaking/searchers', {
        preHandler: [ipRateLimit(ctx, Limits.LobbyListIp)],
    }, async (_req, reply) => {
        reply.header('Cache-Control', 'public, max-age=2');
        return { searchers: ctx.matchmaker?.searchers() ?? [] };
    });
}
