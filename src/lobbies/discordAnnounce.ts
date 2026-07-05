import { fetch } from 'undici';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../env';

/**
 * Optional Discord channel announcements for newly-created lobbies.
 *
 * When <c>DISCORD_WEBHOOK_URL</c> is configured, {@link announceLobbyCreated}
 * posts one embed to that channel each time a room is created, so a community
 * Discord shows at a glance that matches are being assembled. It is a
 * best-effort, fire-and-forget side effect: it MUST never throw into or slow
 * down the lobby-creation request. All fixed text is English on purpose
 * (the channel is community-facing and the mod names are English), matching
 * the server's English-only logs — it never touches the launcher's
 * localization layer. The only variable text is the room name the player
 * typed, which may be in any language.
 */

/**
 * Human-readable names for the first-party mods. Community/catalog mods
 * aren't listed here — {@link modLabel} falls back to the raw <c>mod_id</c>,
 * which the launcher sends verbatim. The server has no mod catalog of its
 * own, so this small map is the only place that knows a "pretty" name.
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

/** The data a room announcement needs — a projection of the lobby row. */
export interface LobbyAnnouncement {
    id: string;
    title: string;
    modId: string;
    maxPlayers: number;
    isPrivate: boolean;
    host: {
        displayName?: string | null;
        discordUsername?: string | null;
    };
}

// Embed accent colours: warm gold for public rooms, muted grey for private.
const COLOR_PUBLIC = 0xE0A82E;
const COLOR_PRIVATE = 0x9AA0A6;

interface EmbedField {
    name: string;
    value: string;
    inline: boolean;
}

/**
 * Post a "new room" embed to the configured Discord webhook. No-op when the
 * webhook isn't configured. Swallows every error (network, rate-limit, bad
 * response) — a failed announcement must not break room creation.
 */
export async function announceLobbyCreated(
    cfg: Config,
    lobby: LobbyAnnouncement,
    log?: FastifyBaseLogger,
): Promise<void> {
    if (!cfg.discordWebhookUrl) return;

    try {
        const mod = modLabel(lobby.modId);
        const hostName =
            lobby.host.displayName || lobby.host.discordUsername || 'Unknown';

        const fields: EmbedField[] = [
            { name: 'Mod', value: mod, inline: true },
            { name: 'Players', value: `1 / ${lobby.maxPlayers}`, inline: true },
            { name: 'Host', value: hostName, inline: true },
        ];
        if (lobby.isPrivate) {
            // Zero-width name → a full-width note row under the inline fields.
            fields.push({
                name: '​',
                value: '🔒 Private · password protected',
                inline: false,
            });
        }

        const embed = {
            title: lobby.isPrivate
                ? `🔒 New private room · ${mod}`
                : `🎮 New room · ${mod}`,
            description: lobby.title,
            color: lobby.isPrivate ? COLOR_PRIVATE : COLOR_PUBLIC,
            fields,
            footer: { text: 'AoE3 Mod Launcher · Multiplayer' },
            timestamp: new Date().toISOString(),
        };

        const resp = await fetch(cfg.discordWebhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'wol-launcher-lobby-node',
            },
            body: JSON.stringify({ embeds: [embed] }),
        });

        if (!resp.ok) {
            const txt = await resp.text().catch(() => '');
            log?.warn(
                { status: resp.status, body: txt.slice(0, 200) },
                'Discord room announcement failed',
            );
        }
    } catch (err) {
        log?.warn({ err }, 'Discord room announcement threw');
    }
}
