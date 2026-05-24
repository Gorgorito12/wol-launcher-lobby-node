/**
 * Standard JSON error shape returned by every endpoint. Identical to the
 * original Worker's contract so the launcher's <c>LobbyApiException</c>
 * keeps parsing without any code changes.
 */
export interface ApiError {
    code: string;
    message: string;
    details?: Record<string, unknown>;
}

export function apiError(
    code: string,
    message: string,
    details?: Record<string, unknown>,
): ApiError {
    if (details) return { code, message, details };
    return { code, message };
}

/**
 * Thrown by route handlers to short-circuit with a structured JSON
 * error. The Fastify error hook in <c>index.ts</c> converts these into
 * the response envelope.
 */
export class HttpError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        public readonly details?: Record<string, unknown>,
    ) {
        super(message);
        this.name = 'HttpError';
    }
}

export const Errors = {
    Unauthorized:    () => new HttpError(401, 'unauthorized',    'Authentication required.'),
    InvalidToken:    () => new HttpError(401, 'invalid_token',   'Session token is invalid or expired.'),
    Forbidden:       () => new HttpError(403, 'forbidden',       'Action not allowed for this user.'),
    NotFound:        (what: string) => new HttpError(404, 'not_found', `${what} not found.`),
    RateLimited:     (retryAfterSec: number) => new HttpError(
        429,
        'rate_limited',
        'Too many requests — slow down.',
        { retry_after: retryAfterSec },
    ),
    QuotaDegraded:   () => new HttpError(
        503,
        'quota_degraded',
        'Daily quota near exhaustion; only critical reads accepted.',
    ),
    QuotaExhausted:  () => new HttpError(
        503,
        'quota_exhausted',
        'Daily request quota exhausted — service will resume tomorrow.',
    ),
    BadRequest:      (msg: string, details?: Record<string, unknown>) =>
        new HttpError(400, 'bad_request', msg, details),
    LobbyFull:       () => new HttpError(409, 'lobby_full',     'Lobby has reached its player cap.'),
    AlreadyInLobby:  () => new HttpError(409, 'already_in_lobby', 'You are already in another lobby.'),
    ModMismatch:     (details: Record<string, unknown>) => new HttpError(
        409,
        'mod_mismatch',
        'Local mod files do not match the host — repair or update before joining.',
        details,
    ),
    UserBanned:      () => new HttpError(403, 'user_banned',    'This account is banned from multiplayer.'),
    Conflict:        (msg: string) => new HttpError(409, 'conflict', msg),
    Internal:        (msg = 'Unexpected server error.') =>
        new HttpError(500, 'internal', msg),
};
