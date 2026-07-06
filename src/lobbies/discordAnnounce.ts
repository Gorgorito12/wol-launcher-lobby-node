import { fetch } from 'undici';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../env';

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
 *  - Per-room state (the posted message ids + the data to re-render the embed)
 *    lives IN MEMORY here — no SQLite column, no migration. A server restart
 *    with an active room just freezes that message at its last state (rooms are
 *    ephemeral and restarts rare — accepted trade-off).
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

/** Stash the shared config + logger. Call once from index.ts at startup. */
export function configure(config: Config, logger: FastifyBaseLogger): void {
    cfg = config;
    log = logger;
}

function webhookUrls(): string[] {
    return cfg?.discordWebhookUrls ?? [];
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

// Embed accent colours by status: gold (waiting), green (in game), grey (closed).
const COLOR_OPEN = 0xe0a82e;
const COLOR_IN_GAME = 0x22c55e;
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

    const payload = { embeds: [buildEmbed(state)] };
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
}

/**
 * Record a change to a tracked room and schedule a debounced edit. No-op when
 * the room isn't tracked (private / webhooks off / not announced).
 */
export function notifyRoomChanged(
    lobbyId: string,
    change: { players?: number; status?: RoomStatus },
): void {
    const state = rooms.get(lobbyId);
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
}

/**
 * Final edit of a room's message to its closing state (default "Closed"), then
 * stop tracking it. The message stays in Discord as history.
 */
export function finalizeRoom(lobbyId: string, status: RoomStatus = 'closed'): void {
    const state = rooms.get(lobbyId);
    if (!state) return;
    if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
    }
    state.status = status;
    rooms.delete(lobbyId);
    void flushEditState(state);
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

function statusLabel(s: RoomStatus): string {
    switch (s) {
        case 'in_game':
            return 'In game';
        case 'closed':
            return 'Closed';
        default:
            return 'Waiting for players';
    }
}

function statusColor(s: RoomStatus): number {
    switch (s) {
        case 'in_game':
            return COLOR_IN_GAME;
        case 'closed':
            return COLOR_CLOSED;
        default:
            return COLOR_OPEN;
    }
}

function buildEmbed(state: RoomAnnounceState): Record<string, unknown> {
    const mod = modLabel(state.modId);
    const author: Record<string, unknown> = { name: state.hostName };
    if (state.hostAvatar) author.icon_url = state.hostAvatar;

    // The room is joinable while it's open (a closed/in-game room can't be
    // joined). Webhooks can't send real buttons, so the "Join" affordance is the
    // most prominent clickable things an embed allows: the TITLE is a link and a
    // bold call-to-action line, both pointing at the HTTPS bounce page (which
    // redirects to wol-launcher://join/<id> and opens the launcher). The
    // "needs the launcher" caveat moves to the footer so it doesn't dominate.
    const joinable = state.status !== 'closed';
    const joinUrl = `${JOIN_LINK_BASE}/j/${encodeURIComponent(state.id)}`;

    const embed: Record<string, unknown> = {
        author,
        title: state.title,
        color: statusColor(state.status),
        fields: [
            { name: 'Mod', value: mod, inline: true },
            { name: 'Players', value: `${state.players} / ${state.maxPlayers}`, inline: true },
            { name: 'Status', value: statusLabel(state.status), inline: true },
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
        embed.url = joinUrl; // makes the room title itself clickable
        embed.description = `▶️ **[Join this room in the launcher](${joinUrl})**`;
    }

    return embed;
}
