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
    // Global chat (the process-wide /global/ws room). Separate knobs from
    // the per-lobby chat so the shared channel can be throttled / bounded
    // independently — it's more spam-prone and its connections + history
    // are the only global-chat memory cost on the 1 GB VM.
    globalChatMsgsPerMin: number;
    globalChatHistory: number;
    globalChatMaxConnections: number;
    // Anti-spam: minimum gap between two messages (slow mode), and an
    // auto-timeout — trip the slow-mode / per-minute limit this many times
    // inside a minute and you're muted for globalChatTimeoutMs.
    globalChatMinIntervalMs: number;
    globalChatTimeoutStrikes: number;
    globalChatTimeoutMs: number;
    dailyRequestBudget: number;
    dailyDegradeThreshold: number;
    dailyHardLimit: number;
    replayMaxBytes: number;
    lobbyMaxPlayers: number;
    devAuthBypass: boolean;

    // Public base URL of this service — used to construct the
    // Discord OAuth redirect_uri. MUST match the entry registered in
    // the Discord Developer Portal exactly (scheme + host + path).
    publicBaseUrl: string;

    // Secrets
    jwtSigningKey: string;
    discordClientId: string;
    discordClientSecret: string;

    // Optional: a Discord channel webhook URL. When set, the server posts a
    // message to that channel every time a lobby is created (name, mod,
    // player count, host). Left blank the feature is simply off — it is NOT
    // part of the hard-fail secret check below, so the service starts fine
    // without it.
    discordWebhookUrl: string;
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
        globalChatMsgsPerMin: intEnv('GLOBAL_CHAT_MSGS_PER_MIN', 20),
        globalChatHistory: intEnv('GLOBAL_CHAT_HISTORY', 100),
        // Default the global-chat capacity to the concurrent-user budget so
        // the room can't hold more sockets than the service is sized for.
        globalChatMaxConnections: intEnv(
            'GLOBAL_CHAT_MAX_CONNECTIONS',
            intEnv('MAX_CONCURRENT_USERS', 60),
        ),
        globalChatMinIntervalMs: intEnv('GLOBAL_CHAT_MIN_INTERVAL_MS', 1500),
        globalChatTimeoutStrikes: intEnv('GLOBAL_CHAT_TIMEOUT_STRIKES', 5),
        globalChatTimeoutMs: intEnv('GLOBAL_CHAT_TIMEOUT_MS', 30_000),
        dailyRequestBudget: intEnv('DAILY_REQUEST_BUDGET', 100_000),
        dailyDegradeThreshold: intEnv('DAILY_DEGRADE_THRESHOLD', 80_000),
        dailyHardLimit: intEnv('DAILY_HARD_LIMIT', 95_000),
        replayMaxBytes: intEnv('REPLAY_MAX_BYTES', 5 * 1024 * 1024),
        lobbyMaxPlayers: intEnv('LOBBY_MAX_PLAYERS', 8),
        devAuthBypass: (process.env.DEV_AUTH_BYPASS || '').toLowerCase() === 'true',

        publicBaseUrl: strEnv('PUBLIC_BASE_URL', ''),

        jwtSigningKey: strEnv('JWT_SIGNING_KEY', ''),
        discordClientId: strEnv('DISCORD_CLIENT_ID', ''),
        discordClientSecret: strEnv('DISCORD_CLIENT_SECRET', ''),

        discordWebhookUrl: strEnv('DISCORD_WEBHOOK_URL', ''),
    };

    // Hard fail on missing secrets — we don't want the service to start
    // and silently fall through with broken auth in production.
    if (!cfg.devAuthBypass) {
        const missing: string[] = [];
        if (!cfg.jwtSigningKey || cfg.jwtSigningKey.startsWith('replace-me')) missing.push('JWT_SIGNING_KEY');
        if (!cfg.discordClientId || cfg.discordClientId.startsWith('replace-me')) missing.push('DISCORD_CLIENT_ID');
        if (!cfg.discordClientSecret || cfg.discordClientSecret.startsWith('replace-me')) missing.push('DISCORD_CLIENT_SECRET');
        if (!cfg.publicBaseUrl || cfg.publicBaseUrl.startsWith('replace-me')) missing.push('PUBLIC_BASE_URL');
        if (missing.length > 0) {
            throw new Error(
                `Missing required env vars: ${missing.join(', ')}. ` +
                `Set them in .env (see .env.example) or set DEV_AUTH_BYPASS=true ` +
                `for local development without Discord.`,
            );
        }
    }

    return cfg;
}
