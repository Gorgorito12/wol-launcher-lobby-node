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
    /**
     * Rooms that may be open at once, across the whole server.
     *
     * Raised from 8 to 16 for tournaments: a 16-entrant first round needs EIGHT rooms
     * simultaneously, which at 8 was the entire budget and left nothing for ordinary
     * play. It is the only enforced cap a tournament can exhaust (lobbies/rest.ts)
     * — MAX_CONCURRENT_USERS is reported to the launcher but never checked anywhere.
     *
     * Cheap to raise because tournament rooms are created with `announce: false`, so a
     * round opening eight at once fires no Discord webhooks and no global toasts.
     */
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
    // Max room invites a user can send over /global/ws per rolling minute.
    globalChatInvitesPerMin: number;
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

    // Optional: Discord channel webhook URLs. When set, the server posts a
    // live-updating message to those channels every time a (public) lobby is
    // created. Several channels/servers can be targeted — the env var accepts a
    // comma-separated list. Empty the feature is simply off — it is NOT part of
    // the hard-fail secret check below, so the service starts fine without it.
    discordWebhookUrls: string[];

    // Discord role IDs to @mention (ping) at the top of the room-creation
    // announcement, so a "Players"/"Jugadores" role gets notified. A role belongs
    // to ONE server, so this is a LIST aligned POSITIONALLY with discordWebhookUrls:
    // roleIds[i] is pinged on webhook[i]. An empty / "none" slot = no ping for that
    // server. Defaults to the WoL community role at index 0 (hardcoded in
    // loadConfig). The displayed text is each role's own name.
    discordPlayersRoleIds: string[];

    // Mod ids whose matches are allowed to move ELO. Everything else is still
    // stored in the match history — it just doesn't score. This is policy, not
    // capability: a rating that adds up wins across mods is adding up games that
    // cannot even be played against each other, since the mod fingerprint gate
    // keeps players of different mods apart. Comma-separated; defaults to the one
    // mod with a real ladder. Widening it needs no code change and no deploy of a
    // new build, only a restart.
    rankedModIds: string[];

    // How long a competitive game must have been running before walking out of it
    // counts as a forfeit. Below this, a player who leaves has almost certainly hit
    // the wrong settings rather than dodged a loss, and the ladder should not care.
    //
    // The floor is not arbitrary: ratability already refuses to score anything under
    // MIN_DURATION_SECONDS (180), so a shorter abandonment could not produce a rated
    // match anyway. 300 leaves two minutes of margin above that and is still the
    // opening phase of an AoE3 1v1. Policy, like rankedModIds — tune it with a
    // restart, not a deploy.
    competitiveAbandonSeconds: number;

    /**
     * The oldest launcher allowed into multiplayer, e.g. "v1.0.14". EMPTY (the
     * default) means no requirement at all — the check is off.
     *
     * <p>Only entry is gated: creating a room, joining one, and the room socket.
     * Reporting a match, the global chat, history and stats stay open, so a client
     * that already played is never punished for it and nobody is cut off from
     * asking for help.</p>
     *
     * <p><b>Never set this above a version that has actually shipped.</b> A client
     * that reports no version at all fails the check by design — it can only be a
     * build from before clients reported one — so setting a minimum before that
     * release is out locks every player out at once. See DEPLOY.md.</p>
     */
    minLauncherVersion: string;
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
 * Parse a comma/newline-separated env var into a list of http(s) URLs. Trims
 * each entry and drops empties + anything that isn't an http(s) URL, so a stray
 * comma or blank line can't produce a bogus target. Returns [] when unset.
 */
function urlListEnv(name: string): string[] {
    return strEnv(name, '')
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter((s) => /^https?:\/\//i.test(s));
}

/**
 * Parse a comma/newline-separated list of Discord role IDs, KEEPING positional
 * slots so it stays index-aligned with the webhook list (an empty or "none" slot
 * becomes '' = "no ping for that server"). This deliberately does NOT drop empties
 * the way urlListEnv does — a middle blank is a meaningful "skip this one". Trailing
 * blanks are harmless. When the env var is unset the caller's fallback is used
 * (e.g. the WoL role at index 0, for out-of-the-box behaviour).
 */
function roleIdListEnv(name: string, fallback: string[]): string[] {
    const raw = process.env[name];
    if (!raw || raw.trim().length === 0) return fallback;
    return raw
        .split(/[,\n]/)
        .map((s) => s.trim())
        .map((s) => (s === '' || s.toLowerCase() === 'none' ? '' : s));
}

/**
 * Parse a comma/newline-separated list of plain ids (no URL shape to validate).
 * Trims, drops empties, lowercases — ids are compared case-insensitively so an
 * operator typing "WoL" in the .env still matches the launcher's "wol".
 */
function idListEnv(name: string, fallback: string[]): string[] {
    const raw = process.env[name];
    if (!raw || raw.trim().length === 0) return fallback;
    const ids = raw
        .split(/[,\n]/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);
    return ids.length > 0 ? ids : fallback;
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
        maxActiveGames: intEnv('MAX_ACTIVE_GAMES', 16),
        chatMsgsPerMin: intEnv('CHAT_MSGS_PER_MIN', 30),
        globalChatMsgsPerMin: intEnv('GLOBAL_CHAT_MSGS_PER_MIN', 20),
        globalChatHistory: intEnv('GLOBAL_CHAT_HISTORY', 100),
        // Global-chat / PRESENCE capacity. Decoupled from MAX_CONCURRENT_USERS
        // (the in-lobby player budget, 60): the launcher now keeps this socket
        // open in the BACKGROUND while signed in — that's how every running
        // launcher shows up as "connected" (presence) — so the cap must cover the
        // whole installed base that's online, not just active lobby players.
        // Default 200 sized for a ~50-150 user community on the 1-core/1GB VM
        // (each idle socket ~50KB in Node + ~50KB in nginx ≈ ~15MB total at 150;
        // pings ~5/s; the presence frame is O(N²) bytes but debounced ~1.5s and
        // event-driven). Bump via GLOBAL_CHAT_MAX_CONNECTIONS; past ~300-500 the
        // full-list presence frame strains the single vCPU → switch to deltas.
        globalChatMaxConnections: intEnv('GLOBAL_CHAT_MAX_CONNECTIONS', 200),
        globalChatMinIntervalMs: intEnv('GLOBAL_CHAT_MIN_INTERVAL_MS', 1500),
        globalChatTimeoutStrikes: intEnv('GLOBAL_CHAT_TIMEOUT_STRIKES', 5),
        globalChatTimeoutMs: intEnv('GLOBAL_CHAT_TIMEOUT_MS', 30_000),
        globalChatInvitesPerMin: intEnv('GLOBAL_CHAT_INVITES_PER_MIN', 10),
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

        discordWebhookUrls: urlListEnv('DISCORD_WEBHOOK_URL'),
        // Per-server ping role ids, aligned by INDEX with DISCORD_WEBHOOK_URL
        // (webhook[i] pings roleIds[i]). This DEFAULT is only a sensible starting
        // value (the WoL-community "Players" role at index 0) — the real per-webhook
        // layout is deployment-specific and lives in the .env, NOT here: with several
        // webhooks (possibly to different servers, some with no ping) the env must
        // list one entry per webhook IN WEBHOOK ORDER, using "none"/empty for a
        // server that should not be pinged, e.g.
        //   DISCORD_PLAYERS_ROLE_ID=none,<serverB_role>,<serverC_role>
        // Don't bake the multi-webhook layout into this default — it drifts from the
        // real webhook order and misleads. A role id is a public identifier, not a
        // secret. NOTE: an env value OVERRIDES this default entirely. See
        // roleIdListEnv — empties/"none" are KEPT as positional placeholders (unlike
        // urlListEnv, which drops them), so the index alignment holds.
        discordPlayersRoleIds: roleIdListEnv('DISCORD_PLAYERS_ROLE_ID', ['1088344884882194563']),

        rankedModIds: idListEnv('RANKED_MOD_IDS', ['wol']),

        competitiveAbandonSeconds: intEnv('COMPETITIVE_ABANDON_SECONDS', 300),
        minLauncherVersion: strEnv('MIN_LAUNCHER_VERSION', ''),
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
