import type { FastifyInstance } from 'fastify';
import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { Errors } from '../lib/errors';
import { uuid } from '../lib/ids';
import { requireAuth } from '../middleware/auth';
import { ipRateLimit, Limits } from '../middleware/rateLimit';
import type { AppContext } from '../context';

/**
 * Replays replace the original R2-backed flow with a plain folder on
 * the VM's disk. Same handle/PUT/GET dance the launcher already speaks,
 * just that the bytes land in <c>REPLAYS_DIR/replays/&lt;match&gt;/&lt;uuid&gt;.age3yrec</c>
 * instead of R2.
 *
 * Safety:
 *   * Object key is generated server-side (uuid in the path); the
 *     client never picks the filename, so they can't traverse out of
 *     the replays root with "../../etc/passwd" style keys.
 *   * We re-resolve the absolute path of the target before writing
 *     and reject anything that wouldn't be a descendant of REPLAYS_DIR
 *     — defence in depth in case a future code change builds the key
 *     from client input.
 */
interface UploadHandleEntry {
    matchId: string;
    userId: string;
    objectKey: string;
}

export function registerReplaysRest(app: FastifyInstance, ctx: AppContext): void {
    // Whatever payload size the host configured plus a small slack
    // for transport overhead. fastify's default is 1 MB — too small.
    app.addContentTypeParser(
        'application/octet-stream',
        { parseAs: 'buffer', bodyLimit: ctx.config.replayMaxBytes + 64 * 1024 },
        (_req, body, done) => done(null, body),
    );

    app.post('/replays/upload-url', {
        preHandler: [requireAuth(), ipRateLimit(ctx, Limits.LobbyJoinIp)],
    }, async (req, reply) => {
        const userId = req.userId!;
        const body = (req.body ?? {}) as { match_id?: string };
        if (!body.match_id) throw Errors.BadRequest('match_id required');

        const ok = await ctx.db.prepare(
            `SELECT 1 FROM match_participants WHERE match_id = ? AND user_id = ? LIMIT 1`,
        ).bind(body.match_id, userId).first();
        if (!ok) throw Errors.Forbidden();

        const handle = uuid();
        const objectKey = `replays/${body.match_id}/${uuid()}.age3yrec`;
        await ctx.kv.put(
            `replay:handle:${handle}`,
            JSON.stringify({ matchId: body.match_id, userId, objectKey } satisfies UploadHandleEntry),
            { expirationTtl: 10 * 60 },
        );

        return reply.send({
            upload_url: `/replays/upload/${handle}`,
            method: 'PUT',
            max_bytes: ctx.config.replayMaxBytes,
            expires_in: 600,
        });
    });

    app.put('/replays/upload/:handle', {
        preHandler: [requireAuth()],
        bodyLimit: ctx.config.replayMaxBytes + 64 * 1024,
    }, async (req, reply) => {
        const userId = req.userId!;
        const handle = (req.params as { handle: string }).handle;
        const stored = await ctx.kv.get(`replay:handle:${handle}`);
        if (!stored) throw Errors.NotFound('Upload handle');
        const entry = JSON.parse(stored) as UploadHandleEntry;
        if (entry.userId !== userId) throw Errors.Forbidden();

        const body = req.body;
        if (!Buffer.isBuffer(body)) {
            throw Errors.BadRequest('Body must be a binary upload (Content-Type: application/octet-stream)');
        }
        if (body.byteLength > ctx.config.replayMaxBytes) {
            throw Errors.BadRequest('Replay exceeds size cap', { max_bytes: ctx.config.replayMaxBytes });
        }

        const root = resolve(ctx.config.replaysDir);
        const target = resolve(join(root, entry.objectKey));
        // Path-traversal guard: ensure target is below root.
        if (!target.startsWith(root + sep) && target !== root) {
            throw Errors.BadRequest('Invalid object key');
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, body);

        await ctx.db.prepare(
            `UPDATE matches SET replay_object_key = ? WHERE id = ?`,
        ).bind(entry.objectKey, entry.matchId).run();
        await ctx.kv.delete(`replay:handle:${handle}`);

        return reply.send({ ok: true, object_key: entry.objectKey });
    });

    app.get('/replays/:matchId', {
        preHandler: [ipRateLimit(ctx, Limits.LobbyListIp)],
    }, async (req, reply) => {
        const matchId = (req.params as { matchId: string }).matchId;
        const row = await ctx.db.prepare(
            `SELECT replay_object_key FROM matches WHERE id = ?`,
        ).bind(matchId).first<{ replay_object_key: string | null }>();
        if (!row || !row.replay_object_key) throw Errors.NotFound('Replay');

        const root = resolve(ctx.config.replaysDir);
        const target = resolve(join(root, row.replay_object_key));
        if (!target.startsWith(root + sep) && target !== root) throw Errors.NotFound('Replay');
        if (!existsSync(target)) throw Errors.NotFound('Replay');

        const st = await stat(target);
        const buf = await readFile(target);
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Content-Disposition', `attachment; filename="${matchId}.age3yrec"`);
        reply.header('Content-Length', String(st.size));
        return reply.send(buf);
    });
}
