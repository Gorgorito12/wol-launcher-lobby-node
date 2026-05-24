import 'dotenv/config';

/**
 * Effective configuration. Mirrors the original Worker's <c>readConfig</c>
 * shape so the rest of the codebase can be ported with minimal edits.
 * Values come from environment variables (loaded by dotenv from .env)
 * with sensible fallbacks for any knob the operator didn't set.
 */
export interface Config {
    // HTTP bind
    port: number;
    host: string;

    // Storage paths
    dbPath: string;
    replaysDir: string;

    // Public tunables — same defaults the original wrangler.toml declared.
    maxConcurrentUsers: number;
    maxActiveGames: number;
    chatMsgsPerMin: number;
    dailyRequestBudget: number;
    dailyDegradeThreshold: number;
    dailyHardLimit: number;
    replayMaxBytes: number;
    lobbyMaxPlayers: number;
    devAuthBypass: boolean;

    // Secrets
    jwtSigningKey: string;
    githubClientId: string;
    githubClientSecret: string;
}

function intEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
}

function strEnv(name: string, fallback: string): string {
    const v = process.env[name];
    return v && v.length > 0 ? v : fallback;
}

/**
 * Resolve the active configuration. Called once at process startup; the
 * rest of the code passes the resulting object around instead of reading
 * process.env directly so unit tests (eventually) can stub it.
 */
export function loadConfig(): Config {
    const cfg: Config = {
        port: intEnv('PORT', 8080),
        host: strEnv('HOST', '127.0.0.1'),

        dbPath: strEnv('DB_PATH', './lobby.db'),
        replaysDir: strEnv('REPLAYS_DIR', './replays'),

        maxConcurrentUsers: intEnv('MAX_CONCURRENT_USERS', 60),
        maxActiveGames: intEnv('MAX_ACTIVE_GAMES', 8),
        chatMsgsPerMin: intEnv('CHAT_MSGS_PER_MIN', 30),
        dailyRequestBudget: intEnv('DAILY_REQUEST_BUDGET', 100_000),
        dailyDegradeThreshold: intEnv('DAILY_DEGRADE_THRESHOLD', 80_000),
        dailyHardLimit: intEnv('DAILY_HARD_LIMIT', 95_000),
        replayMaxBytes: intEnv('REPLAY_MAX_BYTES', 5 * 1024 * 1024),
        lobbyMaxPlayers: intEnv('LOBBY_MAX_PLAYERS', 8),
        devAuthBypass: (process.env.DEV_AUTH_BYPASS || '').toLowerCase() === 'true',

        jwtSigningKey: strEnv('JWT_SIGNING_KEY', ''),
        githubClientId: strEnv('GITHUB_CLIENT_ID', ''),
        githubClientSecret: strEnv('GITHUB_CLIENT_SECRET', ''),
    };

    // Hard fail on missing secrets — we don't want the service to start
    // and silently fall through with broken auth in production.
    if (!cfg.devAuthBypass) {
        const missing: string[] = [];
        if (!cfg.jwtSigningKey || cfg.jwtSigningKey.startsWith('replace-me')) missing.push('JWT_SIGNING_KEY');
        if (!cfg.githubClientId || cfg.githubClientId.startsWith('replace-me')) missing.push('GITHUB_CLIENT_ID');
        if (!cfg.githubClientSecret || cfg.githubClientSecret.startsWith('replace-me')) missing.push('GITHUB_CLIENT_SECRET');
        if (missing.length > 0) {
            throw new Error(
                `Missing required env vars: ${missing.join(', ')}. ` +
                `Set them in .env (see .env.example) or set DEV_AUTH_BYPASS=true ` +
                `for local development without GitHub.`,
            );
        }
    }

    return cfg;
}
