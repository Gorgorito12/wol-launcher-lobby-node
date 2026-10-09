import { HttpError } from '../lib/errors';

/**
 * The decisions behind the replay routes, kept pure so every refusal is pinned by a test
 * (`rules.test.ts`) rather than discovered by a player whose recording silently went nowhere.
 */

/** What the upload routes read about a match. `competitive` comes from the lobby row. */
export interface ReplayMatchRow {
    id: string;
    host_user_id: string;
    mod_id: string;
    started_at: string;
    replay_sha256: string | null;
    replay_key: string | null;
    replay_size_bytes: number | null;
    /** `lobbies.competitive`; NULL when the lobby row is gone, which is "not known", never casual. */
    competitive: number | null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Who may touch a match's recording at all: it must exist, have been played in a COMPETITIVE
 * room, and the caller must be the one who reported it — `matches.host_user_id` is written
 * with the caller's id by `POST /matches`, and that is the room's host, or the player the room
 * promoted when the host left mid-match. Shared by upload-url and confirm.
 */
export function reporterRefusal(match: ReplayMatchRow | null, callerId: string): HttpError | null {
    if (!match) return new HttpError(404, 'not_found', 'Match not found.');
    if (match.competitive !== 1) {
        return new HttpError(409, 'not_competitive', 'Only competitive matches keep their recording.');
    }
    if (match.host_user_id !== callerId) {
        return new HttpError(403, 'not_reporter', 'Only the player who reported this match can upload its recording.');
    }
    return null;
}

/**
 * Every reason `POST /replays/upload-url` says no, in the order they are checked.
 *
 * The fingerprint check compares against what the reporter STORED when reporting. A match
 * reported without one — the recording turned up only after the report went out — is
 * accepted: there is nothing to compare against, and it is still only the reporter's own
 * match, uploaded once.
 */
export function uploadRefusal(input: {
    match: ReplayMatchRow | null;
    callerId: string;
    sizeBytes: unknown;
    sha256: unknown;
    maxBytes: number;
}): HttpError | null {
    const refused = reporterRefusal(input.match, input.callerId);
    if (refused) return refused;

    const size = input.sizeBytes;
    if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
        return new HttpError(400, 'bad_request', 'size_bytes must be a positive integer.');
    }
    if (size > input.maxBytes) {
        return new HttpError(413, 'too_large', 'The recording is larger than the server accepts.', {
            max_bytes: input.maxBytes,
        });
    }

    if (input.sha256 !== undefined && input.sha256 !== null) {
        const sha = typeof input.sha256 === 'string' ? input.sha256.trim().toLowerCase() : '';
        if (!SHA256_HEX.test(sha)) {
            return new HttpError(400, 'bad_request', 'sha256 must be 64 hexadecimal characters.');
        }
        const stored = input.match!.replay_sha256?.trim().toLowerCase();
        if (stored && stored !== sha) {
            return new HttpError(409, 'sha_mismatch', 'This is not the recording the match was reported with.');
        }
    }

    if (input.match!.replay_key) {
        return new HttpError(409, 'already_uploaded', 'This match already has its recording.');
    }
    return null;
}

/**
 * `replays/<mod>/<yyyy>/<matchId>.age3Yrec`. Built only from values the server owns — the
 * match id it generated, the mod id it stored — and sanitised anyway, so no client input can
 * ever shape an object key.
 */
export function objectKeyFor(modId: string, startedAt: string, matchId: string, now = new Date()): string {
    const mod = modId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
    const year = /^(\d{4})-/.exec(startedAt ?? '')?.[1] ?? String(now.getUTCFullYear());
    const id = matchId.replace(/[^A-Za-z0-9-]+/g, '-');
    return `replays/${mod}/${year}/${id}.age3Yrec`;
}

/** Only `[A-Za-z0-9._-]`, accents folded, runs collapsed, no `..`, no edge punctuation. */
function slug(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/\.{2,}/g, '.')
        .replace(/_{2,}/g, '_')
        .replace(/^[._-]+|[._-]+$/g, '');
}

const MAX_NAME_LENGTH = 120;
const EXTENSION = '.age3Yrec';

/**
 * The name a download is saved under: `<yyyy-mm-dd>_<p1>-vs-<p2>_<map>.age3Yrec`.
 *
 * In a team game the two names are the first player of each side, because "A-vs-B-vs-C-vs-D"
 * would read as a free-for-all. Every part is optional and dropped when empty; with nothing
 * usable left the match id names the file, so a download is never called ".age3Yrec".
 */
export function replayFileName(
    startedAt: string | null | undefined,
    players: ReadonlyArray<{ name: string; team: number }>,
    map: string | null | undefined,
    matchId: string,
): string {
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(startedAt ?? '')?.[1] ?? '';

    const teams = [...new Set(players.map((p) => p.team))].sort((a, b) => a - b);
    const picked = teams.length >= 2
        ? teams.slice(0, 2).map((t) => players.find((p) => p.team === t)!)
        : players.slice(0, 2);
    const names = picked.map((p) => slug(p.name)).filter((n) => n.length > 0).join('-vs-');

    let stem = [date, names, slug(map ?? '')].filter((s) => s.length > 0).join('_');
    if (stem.length > MAX_NAME_LENGTH) stem = stem.slice(0, MAX_NAME_LENGTH).replace(/[._-]+$/g, '');
    if (stem.length === 0) stem = slug(matchId) || 'replay';
    return stem + EXTENSION;
}

/**
 * How long a recording stays in the bucket. It MUST match the bucket's lifecycle rule
 * ("delete after 365 days", counted from the upload): the launcher shows a recording as
 * expired from this date on, and a value that disagreed with the bucket would either hide a
 * file that still exists or offer one that is already gone.
 */
export const REPLAY_RETENTION_DAYS = 365;

/** What every match list says about a match's recording. */
export interface ReplayView {
    /** True only while there is a stored object AND it is not past its retention date. */
    has_replay: boolean;
    /**
     * When the recording expires (UTC, ISO 8601), or null when nothing was ever uploaded.
     * `has_replay: false` with a date here is how the launcher knows the match HAD one —
     * "expired" rather than "never recorded".
     */
    replay_expires_at: string | null;
    replay_size_bytes: number | null;
}

/** SQLite's `datetime('now')` text (`YYYY-MM-DD HH:MM:SS`, UTC) as a Date, or null. */
function parseSqliteUtc(value: string | null | undefined): Date | null {
    if (!value) return null;
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : new Date(t);
}

/**
 * The recording fields of one match, from its three replay columns.
 *
 * `replay_uploaded_at` deliberately survives the download route clearing `replay_key` when
 * the bucket no longer has the object — that is what lets a match read "expired" instead of
 * looking as if it had never been recorded.
 */
export function replayView(
    row: { replay_key?: string | null; replay_uploaded_at?: string | null; replay_size_bytes?: number | null },
    now: Date = new Date(),
): ReplayView {
    const uploaded = parseSqliteUtc(row.replay_uploaded_at);
    const expires = uploaded ? new Date(uploaded.getTime() + REPLAY_RETENTION_DAYS * 86_400_000) : null;
    const live = !!row.replay_key && (!expires || expires.getTime() > now.getTime());
    return {
        has_replay: live,
        replay_expires_at: expires ? expires.toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
        replay_size_bytes: live ? row.replay_size_bytes ?? null : null,
    };
}
