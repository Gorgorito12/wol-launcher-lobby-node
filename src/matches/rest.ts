import type { FastifyInstance } from 'fastify';
import { Errors } from '../lib/errors';
import { uuid } from '../lib/ids';
import { requireAuth } from '../middleware/auth';
import { ipRateLimit, Limits } from '../middleware/rateLimit';
import { applyMatch, type ParticipantOutcome } from '../elo/glicko2';
import { finalizeRoom } from '../lobbies/discordAnnounce';
import type { AppContext } from '../context';

interface ReportMatchBody {
    lobby_id?: string;
    mod_id: string;
    mod_combined_hash: string;
    map_name?: string;
    started_at: string;
    ended_at: string;
    duration_seconds: number;
    participants: Array<{
        user_id: string;
        team: number;
        civ?: string;
        score: number;
        result: 0 | 0.5 | 1;
    }>;
}

export function registerMatchesRest(app: FastifyInstance, ctx: AppContext): void {
    // POST /matches — host reports a finished game.
    app.post('/matches', {
        preHandler: [requireAuth(), ipRateLimit(ctx, Limits.LobbyCreateIp)],
    }, async (req, reply) => {
        const userId = req.userId!;
        const body = (req.body ?? null) as ReportMatchBody | null;
        if (!body) throw Errors.BadRequest('JSON body required');
        if (!Array.isArray(body.participants) || body.participants.length < 2) {
            throw Errors.BadRequest('participants[] must have ≥ 2 entries');
        }
        if (!body.mod_id || !body.mod_combined_hash) {
            throw Errors.BadRequest('mod_id and mod_combined_hash required');
        }
        if (!body.started_at || !body.ended_at) {
            throw Errors.BadRequest('started_at and ended_at required');
        }

        if (body.lobby_id) {
            const lobby = await ctx.db.prepare(
                `SELECT host_user_id FROM lobbies WHERE id = ?`,
            ).bind(body.lobby_id).first<{ host_user_id: string }>();
            if (!lobby) throw Errors.NotFound('Lobby');
            if (lobby.host_user_id !== userId) throw Errors.Forbidden();
        } else {
            const self = body.participants.find((p) => p.user_id === userId);
            if (!self) throw Errors.Forbidden();
        }

        const matchId = uuid();
        const totalResult = body.participants.reduce((sum, p) => sum + p.result, 0);
        if (totalResult > body.participants.length / 2 + 0.001) {
            throw Errors.BadRequest('Results sum exceeds N/2 — invalid pattern');
        }

        const inserts = [
            ctx.db.prepare(
                `INSERT INTO matches (id, lobby_id, host_user_id, mod_id, mod_combined_hash,
                                      map_name, duration_seconds, started_at, ended_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
                matchId,
                body.lobby_id ?? null,
                userId,
                body.mod_id,
                body.mod_combined_hash,
                body.map_name ?? null,
                Math.max(0, body.duration_seconds | 0),
                body.started_at,
                body.ended_at,
            ),
        ];
        for (const p of body.participants) {
            inserts.push(ctx.db.prepare(
                `INSERT INTO match_participants (match_id, user_id, team, civ, score, result)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            ).bind(matchId, p.user_id, p.team | 0, p.civ ?? null, p.score | 0, p.result));
        }
        await ctx.db.batch(inserts);

        const outcomes: ParticipantOutcome[] = body.participants.map((p) => ({
            userId: p.user_id,
            result: p.result,
        }));
        const diff = await applyMatch(ctx.db, outcomes);

        const updates = [];
        for (const p of body.participants) {
            const d = diff.get(p.user_id);
            if (!d) continue;
            updates.push(ctx.db.prepare(
                `UPDATE match_participants SET rating_before = ?, rating_after = ?
                 WHERE match_id = ? AND user_id = ?`,
            ).bind(d.before, d.after, matchId, p.user_id));
        }
        if (updates.length) await ctx.db.batch(updates);

        if (body.lobby_id) {
            await ctx.db.prepare(
                `UPDATE lobbies SET status = 'closed', closed_at = datetime('now') WHERE id = ?`,
            ).bind(body.lobby_id).run();
            ctx.rooms.close(body.lobby_id, 4007, 'match_reported');
            finalizeRoom(body.lobby_id);
        }

        return reply.send({
            match_id: matchId,
            rating_changes: body.participants.map((p) => {
                const d = diff.get(p.user_id);
                return {
                    user_id: p.user_id,
                    rating_before: d?.before ?? null,
                    rating_after: d?.after ?? null,
                };
            }),
        });
    });

    app.get('/matches/history/:userId', {
        preHandler: [ipRateLimit(ctx, Limits.StatsIp)],
    }, async (req, reply) => {
        const userId = (req.params as { userId: string }).userId;
        const rows = await ctx.db.prepare(
            `SELECT m.id, m.mod_id, m.map_name, m.duration_seconds, m.started_at, m.ended_at,
                    m.replay_object_key, mp.team, mp.civ, mp.score, mp.result,
                    mp.rating_before, mp.rating_after
             FROM match_participants mp
             JOIN matches m ON m.id = mp.match_id
             WHERE mp.user_id = ?
             ORDER BY m.started_at DESC
             LIMIT 50`,
        ).bind(userId).all();
        return reply.send({ matches: rows.results ?? [] });
    });

    app.get('/matches/elo/:userId', {
        preHandler: [ipRateLimit(ctx, Limits.StatsIp)],
    }, async (req, reply) => {
        const userId = (req.params as { userId: string }).userId;
        const row = await ctx.db.prepare(
            `SELECT rating, rd, volatility, games_played, updated_at
             FROM elo_ratings WHERE user_id = ? AND mode = 'default'`,
        ).bind(userId).first<{
            rating: number;
            rd: number;
            volatility: number;
            games_played: number;
            updated_at: string;
        }>();
        if (!row) return reply.send({
            rating: 1500, rd: 350, volatility: 0.06, games_played: 0,
        });
        return reply.send(row);
    });
}
