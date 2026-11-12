import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { fetch } from 'undici';
import { Errors, HttpError } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { userRateLimit, Limits } from '../middleware/rateLimit';
import { USER_DISPLAY_NAME_SQL } from '../tournaments/store';
import type { AppContext } from '../context';
import { presignObject, type ReplayStorage } from './presign';
import {
    objectKeyFor,
    replayFileName,
    reporterRefusal,
    uploadRefusal,
    type ReplayMatchRow,
} from './rules';

/**
 * Recordings of COMPETITIVE matches, kept in an S3-compatible bucket (Oracle Object Storage).
 *
 * The one rule this module exists to hold: **the bytes never pass through this server.** It
 * signs short-lived URLs and records what the bucket says; the launcher PUTs and GETs the
 * file against the bucket directly. That is what keeps a 2 MB upload from competing with
 * rooms and chat on a 1 GB VM, and why the old local-disk upload route is gone.
 *
 * The flow, all authenticated:
 *   1. POST /replays/upload-url — the reporter of a competitive match asks to upload; the
 *      answer is a PUT URL whose signature covers the exact size declared.
 *   2. PUT <url>                — the launcher, straight to the bucket.
 *   3. POST /replays/confirm    — the server checks the object exists (HEAD) and only then
 *      records it on the match. Nothing is recorded on the strength of the client's word.
 *   4. GET /matches/:id/replay-url — any signed-in player gets a GET URL that saves the file
 *      under a readable name. The object is HEAD-checked first: the bucket's lifecycle rule
 *      deletes recordings after a year, and a link to a deleted object is worse than "none".
 */

const UPLOAD_URL_SECONDS = 15 * 60;
const DOWNLOAD_URL_SECONDS = 10 * 60;
const CHECK_URL_SECONDS = 60;
const STORAGE_TIMEOUT_MS = 10_000;

const MATCH_SQL = `
    SELECT m.id, m.host_user_id, m.mod_id, m.started_at, m.replay_sha256,
           m.replay_key, m.replay_size_bytes, l.competitive
    FROM matches m
    LEFT JOIN lobbies l ON l.id = m.lobby_id
    WHERE m.id = ?`;

function requireStorage(ctx: AppContext): ReplayStorage {
    const storage = ctx.config.replayStorage;
    if (!storage) throw Errors.ReplaysDisabled();
    return storage;
}

function matchIdFrom(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(value)) {
        throw Errors.BadRequest('match_id required');
    }
    return value;
}

async function loadMatch(ctx: AppContext, matchId: string): Promise<ReplayMatchRow | null> {
    return (await ctx.db.prepare(MATCH_SQL).bind(matchId).first<ReplayMatchRow>()) ?? null;
}

/**
 * Asks the bucket whether an object exists, through a presigned HEAD. Anything but a clear
 * yes or a clear no is a 502: a storage hiccup must never be recorded as "no recording".
 */
async function headObject(
    storage: ReplayStorage,
    key: string,
    log: FastifyBaseLogger,
): Promise<{ exists: boolean; size: number }> {
    const url = presignObject(storage, 'HEAD', key, { expiresSec: CHECK_URL_SECONDS });
    try {
        const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS) });
        if (res.status === 404) return { exists: false, size: 0 };
        if (!res.ok) {
            log.warn({ status: res.status, key }, 'replay HEAD refused by storage');
            throw Errors.StorageError();
        }
        const size = Number(res.headers.get('content-length') ?? '0');
        return { exists: true, size: Number.isFinite(size) ? size : 0 };
    } catch (err) {
        if (err instanceof HttpError) throw err;
        log.warn({ err, key }, 'replay HEAD failed');
        throw Errors.StorageError();
    }
}

/** Best-effort removal of an object we refuse to keep. A failure is logged, never thrown. */
async function deleteObject(storage: ReplayStorage, key: string, log: FastifyBaseLogger): Promise<void> {
    const url = presignObject(storage, 'DELETE', key, { expiresSec: CHECK_URL_SECONDS });
    try {
        const res = await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS) });
        if (!res.ok && res.status !== 404) log.warn({ status: res.status, key }, 'replay DELETE refused by storage');
    } catch (err) {
        log.warn({ err, key }, 'replay DELETE failed');
    }
}

export function registerReplaysRest(app: FastifyInstance, ctx: AppContext): void {
    app.post('/replays/upload-url', {
        preHandler: [requireAuth(), userRateLimit(ctx, Limits.ReplayUploadUser)],
    }, async (req, reply) => {
        const storage = requireStorage(ctx);
        const userId = req.userId!;
        const body = (req.body ?? {}) as { match_id?: unknown; size_bytes?: unknown; sha256?: unknown };
        const matchId = matchIdFrom(body.match_id);

        const match = await loadMatch(ctx, matchId);
        const refused = uploadRefusal({
            match,
            callerId: userId,
            sizeBytes: body.size_bytes,
            sha256: body.sha256,
            maxBytes: ctx.config.replayMaxBytes,
        });
        if (refused) throw refused;

        const key = objectKeyFor(match!.mod_id, match!.started_at, match!.id);
        const uploadUrl = presignObject(storage, 'PUT', key, {
            expiresSec: UPLOAD_URL_SECONDS,
            // Signed, so the bucket refuses a body of any other size: the cap is enforced by
            // the storage itself, not by trusting the client to have measured honestly.
            signedHeaders: { 'content-length': String(body.size_bytes) },
        });

        req.log.info({ matchId, userId, size: body.size_bytes }, 'replay upload URL issued');
        return reply.send({
            upload_url: uploadUrl,
            method: 'PUT',
            max_bytes: ctx.config.replayMaxBytes,
            expires_in: UPLOAD_URL_SECONDS,
        });
    });

    app.post('/replays/confirm', {
        preHandler: [requireAuth(), userRateLimit(ctx, Limits.ReplayUploadUser)],
    }, async (req, reply) => {
        const storage = requireStorage(ctx);
        const userId = req.userId!;
        const body = (req.body ?? {}) as { match_id?: unknown };
        const matchId = matchIdFrom(body.match_id);

        const match = await loadMatch(ctx, matchId);
        const refused = reporterRefusal(match, userId);
        if (refused) throw refused;

        // Idempotent: a launcher that lost the first answer and confirms again gets the same.
        if (match!.replay_key) {
            return reply.send({ ok: true, size_bytes: match!.replay_size_bytes ?? 0 });
        }

        const key = objectKeyFor(match!.mod_id, match!.started_at, match!.id);
        const head = await headObject(storage, key, req.log);
        if (!head.exists) {
            throw new HttpError(404, 'not_uploaded', 'The recording has not reached the storage.');
        }
        if (head.size > ctx.config.replayMaxBytes) {
            // Cannot happen through a URL this server signed (the size is in the signature),
            // but the cap is a promise about the bucket's contents, so it is kept regardless.
            await deleteObject(storage, key, req.log);
            throw new HttpError(413, 'too_large', 'The recording is larger than the server accepts.', {
                max_bytes: ctx.config.replayMaxBytes,
            });
        }

        await ctx.db.prepare(
            `UPDATE matches
                SET replay_key = ?, replay_size_bytes = ?, replay_uploaded_at = datetime('now'),
                    replay_uploader_id = ?
              WHERE id = ? AND replay_key IS NULL`,
        ).bind(key, head.size, userId, matchId).run();

        req.log.info({ matchId, userId, size: head.size }, 'replay stored');
        return reply.send({ ok: true, size_bytes: head.size });
    });

    app.get('/matches/:id/replay-url', {
        preHandler: [requireAuth(), userRateLimit(ctx, Limits.ReplayDownloadUser)],
    }, async (req, reply) => {
        const storage = requireStorage(ctx);
        const matchId = matchIdFrom((req.params as { id?: unknown }).id);

        const row = await ctx.db.prepare(
            `SELECT id, map_name, started_at, replay_key, replay_size_bytes FROM matches WHERE id = ?`,
        ).bind(matchId).first<{
            id: string;
            map_name: string | null;
            started_at: string;
            replay_key: string | null;
            replay_size_bytes: number | null;
        }>();
        if (!row || !row.replay_key) {
            throw new HttpError(404, 'no_replay', 'This match has no stored recording.');
        }

        const head = await headObject(storage, row.replay_key, req.log);
        if (!head.exists) {
            // The bucket's lifecycle rule removed it (recordings are kept a year). Forget it,
            // so the history stops offering a download that cannot happen.
            await ctx.db.prepare(
                `UPDATE matches SET replay_key = NULL, replay_size_bytes = NULL WHERE id = ?`,
            ).bind(matchId).run();
            throw new HttpError(404, 'no_replay', 'This match has no stored recording.');
        }

        const players = await ctx.db.prepare(
            `SELECT ${USER_DISPLAY_NAME_SQL} AS name, mp.team AS team
               FROM match_participants mp
               JOIN users u ON u.id = mp.user_id
              WHERE mp.match_id = ?
              ORDER BY mp.team, mp.result DESC, name`,
        ).bind(matchId).all<{ name: string; team: number | null }>();

        const fileName = replayFileName(
            row.started_at,
            (players.results ?? []).map((p) => ({ name: p.name, team: p.team ?? 0 })),
            row.map_name,
            row.id,
        );
        const url = presignObject(storage, 'GET', row.replay_key, {
            expiresSec: DOWNLOAD_URL_SECONDS,
            query: { 'response-content-disposition': `attachment; filename="${fileName}"` },
        });

        return reply.send({
            url,
            expires_in: DOWNLOAD_URL_SECONDS,
            file_name: fileName,
            size_bytes: head.size || row.replay_size_bytes || 0,
        });
    });
}
