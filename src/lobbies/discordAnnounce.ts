import { fetch } from 'undici';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../env';
import type { Db } from '../db';

/**
 * Optional Discord channel announcements for lobbies, with LIVE updates.
 *
 * When one or more webhooks are configured (`DISCORD_WEBHOOK_URL`, comma-
 * separated for several channels/servers), a room's message is posted on
 * creation and then EDITED in place as the room changes — player count and
 * status (Waiting → In game → Closed) — so a community Discord shows current
 * activity, not a stale snapshot. When the room closes the message is edited to
 * "Closed" and kept as history.
 *
 * Design / cost:
 *  - Best-effort and non-blocking: it must NEVER throw into or slow down room
 *    creation or the WS broadcast path. Every network call swallows its errors.
 *  - Private rooms are NOT announced at all.
 *  - Per-room state is cached in memory for the hot path, but the posted message
 *    ids are ALSO PERSISTED on `lobbies.discord_targets` (migration 0002), and a
 *    cache miss REHYDRATES from the DB — see `ensureState`. This used to be
 *    memory-only on the theory that restarts were rare; the reality was that any
 *    restart orphaned every live announcement (the room vanished from the Map,
 *    so `finalizeRoom` returned early and the embed stayed "Open" forever, even
 *    once the room had closed). Rehydration is what lets every close path still
 *    edit the message across a restart, and what lets a REVIVED room (clients
 *    auto-reconnect, so the lobby WS route rebuilds the room from the DB) keep
 *    getting live edits.
 *  - Edits are debounced (~2 s) so a burst of joins is one edit, well within
 *    Discord's per-webhook edit rate limit.
 *  - All fixed text is English on purpose (community-facing, mirrors the
 *    server's English logs); the only variable text is the player-typed room
 *    name. The pretty mod name comes from the small `MOD_LABELS` map (the server
 *    has no mod catalog), falling back to the raw `mod_id`.
 */

// ---------- shared config, stashed once at startup by configure() -----------
let cfg: Config | null = null;
let log: FastifyBaseLogger | null = null;
let database: Db | null = null;

/** Stash the shared config + logger + db. Call once from index.ts at startup. */
export function configure(config: Config, logger: FastifyBaseLogger, db: Db): void {
    cfg = config;
    log = logger;
    database = db;
}

function webhookUrls(): string[] {
    return cfg?.discordWebhookUrls ?? [];
}

/**
 * The ID segment of a Discord webhook URL (`.../webhooks/<id>/<token>`) — the
 * public half. We persist only this and re-pair it with the configured URL (and
 * therefore its secret token) at edit time, so the DB never holds a credential.
 * Returns null for a URL that doesn't look like a webhook.
 */
function webhookIdOf(url: string): string | null {
    const m = /\/webhooks\/(\d+)\//.exec(url);
    return m ? m[1] : null;
}

/** Resolve a persisted webhook id back to its configured URL, if still present. */
function urlForWebhookId(id: string): string | null {
    for (const url of webhookUrls()) {
        if (webhookIdOf(url) === id) return url;
    }
    return null;
}

// ---------- in-memory per-room state ----------------------------------------
type RoomStatus = 'open' | 'in_game' | 'closed';

interface Target {
    /** The webhook base URL, e.g. https://discord.com/api/webhooks/<id>/<token> */
    url: string;
    /** The id of the message we posted to that webhook (for PATCH edits). */
    messageId: string;
}

interface RoomAnnounceState {
    id: string;
    title: string;
    modId: string;
    maxPlayers: number;
    hostName: string;
    hostAvatar: string | null;
    players: number;
    status: RoomStatus;
    createdAt: string;
    targets: Target[];
    /** players+status of the last render, to skip no-op edits. */
    lastKey: string;
    /** pending debounced-edit timer, or null. */
    timer: ReturnType<typeof setTimeout> | null;
}

const rooms = new Map<string, RoomAnnounceState>();

/**
 * Rehydrations currently in flight, keyed by lobby id. Without this, two close
 * calls racing on the same untracked lobby would each build their own state and
 * double-PATCH the message.
 */
const rehydrating = new Map<string, Promise<RoomAnnounceState | null>>();

const EDIT_DEBOUNCE_MS = 2000;

// Base URL for mod icons in the public catalog repo. `<base>/<modId>/icon.png`;
// an unknown mod 404s and Discord simply omits the thumbnail.
const MOD_ICON_BASE =
    'https://raw.githubusercontent.com/Gorgorito12/aoe3-mods-catalog/main/mods';

// Public base for the "Join" deep-link bounce page (GET /j/:id in index.ts).
// Discord can't linkify a custom scheme (wol-launcher://) directly, so the embed
// links to this HTTPS URL, which redirects the browser to the launcher's scheme.
// Change if the backend is hosted elsewhere.
const JOIN_LINK_BASE = 'https://wol-lobby.duckdns.org';

// Embed accent colours by state — the universal "traffic-light + presence" reading
// (green = go/join, amber = caution/full, blue = in progress, grey = inactive):
//   open = green, full = amber, in game = blue, closed = grey.
const COLOR_OPEN = 0x22c55e;
const COLOR_FULL = 0xf59e0b;
const COLOR_IN_GAME = 0x3b82f6;
const COLOR_CLOSED = 0x9aa0a6;

/**
 * Human-readable names for the first-party mods. Community/catalog mods fall
 * back to the raw `mod_id` (which the launcher sends verbatim) — the server has
 * no mod catalog of its own, so this small map is the only "pretty name" source.
 */
const MOD_LABELS: Record<string, string> = {
    'wol': 'Wars of Liberty',
    'improvement-mod': 'Improvement Mod',
    'aoe3-tad': 'Age of Empires III: The Asian Dynasties',
};

/** Resolve a mod id to its display name, or the raw id when unknown. */
export function modLabel(id: string): string {
    return MOD_LABELS[id.toLowerCase()] ?? id;
}

// ---------- public API ------------------------------------------------------
export interface NewRoom {
    id: string;
    title: string;
    modId: string;
    maxPlayers: number;
    isPrivate: boolean;
    hostName: string;
    hostAvatar?: string | null;
}

/**
 * Post the initial "new room" embed to every configured webhook and start
 * tracking the room for live edits. No-op when no webhook is configured or the
 * room is private. Fire-and-forget from the caller.
 */
export async function announceLobbyCreated(room: NewRoom): Promise<void> {
    const urls = webhookUrls();
    if (urls.length === 0 || room.isPrivate) return;

    const state: RoomAnnounceState = {
        id: room.id,
        title: room.title,
        modId: room.modId,
        maxPlayers: room.maxPlayers,
        hostName: room.hostName || 'Unknown',
        hostAvatar: room.hostAvatar ?? null,
        players: 1,
        status: 'open',
        createdAt: new Date().toISOString(),
        targets: [],
        lastKey: '',
        timer: null,
    };
    // Register BEFORE the POST so an immediate join isn't lost; flushEdit skips
    // targets that have no message id yet.
    rooms.set(room.id, state);
    state.lastKey = renderKey(state);

    // Optionally @mention a role (e.g. "Players"/"Jugadores") so the community
    // gets pinged. The mention MUST live in `content` — embeds never notify —
    // and only on this create POST (edits keep the embed but never re-ping).
    // allowed_mentions is restricted to that one role so a player-typed room
    // name can never @everyone/@here.
    const roleId = cfg?.discordPlayersRoleId ?? '';
    const payload: Record<string, unknown> = { embeds: [buildEmbed(state)] };
    if (roleId) {
        payload.content = `<@&${roleId}>`;
        payload.allowed_mentions = { parse: [], roles: [roleId] };
    }
    await Promise.allSettled(
        urls.map(async (url) => {
            try {
                // `?wait=true` makes Discord return the created message object,
                // so we capture its id to edit later.
                const resp = await fetch(`${url}?wait=true`, {
                    method: 'POST',
                    headers: jsonHeaders(),
                    body: JSON.stringify(payload),
                });
                if (!resp.ok) {
                    const txt = await resp.text().catch(() => '');
                    log?.warn(
                        { status: resp.status, body: txt.slice(0, 200) },
                        'Discord room announce failed',
                    );
                    return;
                }
                const msg = (await resp.json().catch(() => null)) as { id?: string } | null;
                if (msg?.id) state.targets.push({ url, messageId: msg.id });
            } catch (err) {
                log?.warn({ err }, 'Discord room announce threw');
            }
        }),
    );

    // Persist the message ids so a restart doesn't orphan this announcement.
    await persistTargets(state);
}

/**
 * Write a room's message ids onto its `lobbies` row. Best-effort: a failure only
 * costs us the ability to edit the embed after a restart, which is exactly the
 * old behaviour, so it must never bubble into room creation.
 */
async function persistTargets(state: RoomAnnounceState): Promise<void> {
    if (!database) return;
    try {
        const rows = state.targets
            .map((t) => {
                const w = webhookIdOf(t.url);
                return w ? { w, m: t.messageId } : null;
            })
            .filter((r): r is { w: string; m: string } => r !== null);
        if (rows.length === 0) return;
        await database.prepare(
            `UPDATE lobbies SET discord_targets = ? WHERE id = ?`,
        ).bind(JSON.stringify(rows), state.id).run();
    } catch (err) {
        log?.warn({ err, lobbyId: state.id }, 'Discord targets persist failed');
    }
}

/**
 * Rebuild a room's announce state from the DB — used when the in-memory cache
 * misses (i.e. after a restart, for a room announced by the previous process).
 * Everything the embed renders already lives on the `lobbies` row plus the host's
 * `users` row; only the message ids needed the new column.
 *
 * Returns null when there's nothing to edit: no row, no persisted targets (a
 * private room / webhooks were off / a pre-migration lobby), or none of the
 * persisted webhook ids is still configured.
 */
async function rehydrate(lobbyId: string): Promise<RoomAnnounceState | null> {
    if (!database || webhookUrls().length === 0) return null;
    try {
        const row = await database.prepare(
            `SELECT l.id, l.title, l.mod_id, l.max_players, l.current_players, l.status,
                    l.created_at, l.discord_targets,
                    u.display_name, u.discord_username, u.avatar_url
             FROM lobbies l JOIN users u ON u.id = l.host_user_id
             WHERE l.id = ?`,
        ).bind(lobbyId).first<{
            id: string;
            title: string;
            mod_id: string;
            max_players: number;
            current_players: number;
            status: string;
            created_at: string;
            discord_targets: string | null;
            display_name: string | null;
            discord_username: string | null;
            avatar_url: string | null;
        }>();
        if (!row?.discord_targets) return null;

        const parsed = JSON.parse(row.discord_targets) as Array<{ w: string; m: string }>;
        const targets: Target[] = [];
        for (const t of parsed) {
            const url = urlForWebhookId(t.w);
            if (url) targets.push({ url, messageId: t.m });
        }
        if (targets.length === 0) return null;

        // created_at is stored by SQLite's datetime('now') as 'YYYY-MM-DD HH:MM:SS'
        // (space-separated, no zone). Normalise to ISO-UTC so Date.parse gives the
        // right instant — the embed's "Opened <t:unix:R>" would otherwise be read
        // as local time and drift by the host's offset.
        const createdAt = normaliseSqliteTimestamp(row.created_at);

        const state: RoomAnnounceState = {
            id: row.id,
            title: row.title,
            modId: row.mod_id,
            maxPlayers: row.max_players,
            hostName: row.display_name || row.discord_username || 'Unknown',
            hostAvatar: row.avatar_url ?? null,
            players: row.current_players,
            status: (row.status === 'in_game' ? 'in_game'
                : row.status === 'closed' ? 'closed'
                    : 'open') as RoomStatus,
            createdAt,
            targets,
            lastKey: '',
            timer: null,
        };
        state.lastKey = renderKey(state);
        return state;
    } catch (err) {
        log?.warn({ err, lobbyId }, 'Discord announce rehydrate failed');
        return null;
    }
}

/**
 * SQLite's datetime('now') yields 'YYYY-MM-DD HH:MM:SS' in UTC with no zone
 * marker, which Date.parse reads as LOCAL time. Convert to ISO-8601 UTC. An
 * already-ISO value (what announceLobbyCreated stores in memory) passes through.
 */
function normaliseSqliteTimestamp(ts: string): string {
    if (!ts) return new Date().toISOString();
    if (ts.includes('T')) return ts;
    return `${ts.replace(' ', 'T')}Z`;
}

/**
 * The room's live state, rehydrating from the DB on a cache miss. Concurrent
 * callers for the same lobby share one rehydration.
 */
async function ensureState(lobbyId: string): Promise<RoomAnnounceState | null> {
    const cached = rooms.get(lobbyId);
    if (cached) return cached;

    const inFlight = rehydrating.get(lobbyId);
    if (inFlight) return inFlight;

    const p = rehydrate(lobbyId).then((state) => {
        // Re-check the cache: a concurrent announce may have registered the room
        // while we were reading the DB — that copy is fresher, so it wins.
        const now = rooms.get(lobbyId);
        if (now) return now;
        if (state) rooms.set(lobbyId, state);
        return state;
    }).finally(() => {
        rehydrating.delete(lobbyId);
    });
    rehydrating.set(lobbyId, p);
    return p;
}

/**
 * Record a change to a room and schedule a debounced edit. No-op when the room
 * has no announcement to edit (private / webhooks off / never announced).
 *
 * Stays SYNCHRONOUS: it's called from the WS broadcast path, which must not be
 * slowed down or made failable. The rehydrating lookup is fire-and-forget.
 */
export function notifyRoomChanged(
    lobbyId: string,
    change: { players?: number; status?: RoomStatus },
): void {
    void (async () => {
        const state = await ensureState(lobbyId);
        if (!state) return;
        if (typeof change.players === 'number') state.players = change.players;
        if (change.status) state.status = change.status;

        const key = renderKey(state);
        if (key === state.lastKey) return; // nothing visible changed
        state.lastKey = key;

        // A flush already pending will render the latest state when it fires.
        if (state.timer) return;
        state.timer = setTimeout(() => {
            state.timer = null;
            void flushEdit(lobbyId);
        }, EDIT_DEBOUNCE_MS);
    })();
}

/**
 * Final edit of a room's message to its closing state (default "Closed"), then
 * stop tracking it. The message stays in Discord as history.
 *
 * Rehydrates on a cache miss, which is the whole point: the callers (the
 * "creating a room closes my prior one" loop, the host-leave paths, the
 * match-reported close, the startup orphan sweep) routinely fire for a room
 * announced by a PREVIOUS process, and this used to return early and leave the
 * embed reading "Open" forever.
 */
export function finalizeRoom(lobbyId: string, status: RoomStatus = 'closed'): void {
    void (async () => {
        const state = await ensureState(lobbyId);
        if (!state) return;
        if (state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }
        state.status = status;
        rooms.delete(lobbyId);
        await flushEditState(state);
    })();
}

// ---------- internals -------------------------------------------------------
function renderKey(state: RoomAnnounceState): string {
    return `${state.players}|${state.status}`;
}

function jsonHeaders(): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'User-Agent': 'wol-launcher-lobby-node',
    };
}

async function flushEdit(lobbyId: string): Promise<void> {
    const state = rooms.get(lobbyId);
    if (!state) return;
    await flushEditState(state);
}

async function flushEditState(state: RoomAnnounceState): Promise<void> {
    if (state.targets.length === 0) return;
    const payload = { embeds: [buildEmbed(state)] };
    await Promise.allSettled(
        state.targets.map(async (t) => {
            try {
                const resp = await fetch(`${t.url}/messages/${t.messageId}`, {
                    method: 'PATCH',
                    headers: jsonHeaders(),
                    body: JSON.stringify(payload),
                });
                if (!resp.ok) {
                    const txt = await resp.text().catch(() => '');
                    log?.warn(
                        { status: resp.status, body: txt.slice(0, 200) },
                        'Discord room edit failed',
                    );
                }
            } catch (err) {
                log?.warn({ err }, 'Discord room edit threw');
            }
        }),
    );
}

// A "full" room is still 'open' on the wire — collapse (status + player count)
// into one effective state so the colour, emoji and label all agree.
type EffectiveState = 'open' | 'full' | 'in_game' | 'closed';

function effectiveState(s: RoomAnnounceState): EffectiveState {
    if (s.status === 'closed') return 'closed';
    if (s.status === 'in_game') return 'in_game';
    if (s.maxPlayers > 0 && s.players >= s.maxPlayers) return 'full';
    return 'open';
}

// Per-state presentation: a colour dot (so the state is visible IN the content,
// not just the thin border bar), a label, and the border colour.
const STATE_META: Record<EffectiveState, { dot: string; label: string; color: number }> = {
    open: { dot: '🟢', label: 'Open', color: COLOR_OPEN },
    full: { dot: '🟡', label: 'Full', color: COLOR_FULL },
    in_game: { dot: '🔵', label: 'In game', color: COLOR_IN_GAME },
    closed: { dot: '⚫', label: 'Closed', color: COLOR_CLOSED },
};

/**
 * Compact English duration, e.g. "1h 5m" / "12m" / "45s". Zero units are
 * omitted. Only used for the CLOSED state's "Lasted" field — while a room is
 * open the uptime is a Discord live relative timestamp (see buildEmbed), so no
 * duration is formatted server-side for active rooms.
 */
function formatDuration(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
}

function buildEmbed(state: RoomAnnounceState): Record<string, unknown> {
    const mod = modLabel(state.modId);
    const author: Record<string, unknown> = { name: state.hostName };
    if (state.hostAvatar) author.icon_url = state.hostAvatar;

    const st = effectiveState(state);
    const meta = STATE_META[st];

    // Uptime. While the room is live, use Discord's native RELATIVE timestamp
    // `<t:unix:R>` — the client renders "5 minutes ago" and updates it live,
    // localised per viewer, at ZERO server cost (no polling / edits / timers).
    // Once closed, freeze it to a static total duration so it doesn't keep
    // counting forever. createdAt is an ISO string; floor to unix seconds.
    const openedUnix = Math.floor(Date.parse(state.createdAt) / 1000);
    const uptimeField =
        st === 'closed'
            ? { name: 'Lasted', value: formatDuration(Date.now() - Date.parse(state.createdAt)), inline: true }
            : { name: 'Opened', value: `<t:${openedUnix}:R>`, inline: true };

    // Joinable only when there's a point: an open OR full room (a slot can free
    // up in a full one). In-game and closed rooms can't be joined, so they drop
    // the ▶️ Join affordance. Webhooks can't send real buttons, so the "Join" is
    // the most prominent clickable things an embed allows: the TITLE is a link and
    // a bold call-to-action line, both pointing at the HTTPS bounce page (which
    // redirects to wol-launcher://join/<id> and opens the launcher). The "needs
    // the launcher" caveat lives in the footer so it doesn't dominate.
    const joinable = st === 'open' || st === 'full';
    const joinUrl = `${JOIN_LINK_BASE}/j/${encodeURIComponent(state.id)}`;

    const embed: Record<string, unknown> = {
        author,
        // Colour dot beside the title so the state reads at a glance, before the
        // fields — reinforced by the same colour in the border bar + Status field.
        title: `${meta.dot} ${state.title}`,
        color: meta.color,
        fields: [
            { name: 'Mod', value: mod, inline: true },
            { name: 'Players', value: `${state.players} / ${state.maxPlayers}`, inline: true },
            { name: 'Status', value: `${meta.dot} ${meta.label}`, inline: true },
            uptimeField,
        ],
        thumbnail: { url: `${MOD_ICON_BASE}/${encodeURIComponent(state.modId)}/icon.png` },
        footer: {
            text: joinable
                ? 'AoE3 Mod Launcher · Requires the launcher to join'
                : 'AoE3 Mod Launcher · Multiplayer',
        },
        timestamp: state.createdAt,
    };

    if (joinable) {
        // A single, prominent "Join" call-to-action. `## ` renders as a large,
        // bold header in Discord; the [text](url) inside stays a clickable link —
        // the most button-like affordance a webhook embed allows (no real buttons
        // without a bot). The room title stays plain text (a second link read as
        // two join buttons). No `**` — the header is already bold.
        embed.description = `## ▶️ [Join this room in the launcher](${joinUrl})`;
    }

    return embed;
}
