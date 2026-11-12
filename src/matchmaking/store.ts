/**
 * The Matchmaker's window onto the rest of the server: the database, the room creation path
 * and Discord. Kept apart from Matchmaker.ts so that file can be driven by a test with a fake.
 */
import type { AppContext } from '../context';
import { effectiveRatings } from '../elo/ladder';
import { isInPlacement } from '../elo/placement';
import { isRankedMod } from '../elo/ratability';
import { badgeModes } from '../users/badgeMode';
import { ladderRanks } from '../stats/rest';
import { createLobby } from '../lobbies/create';
import { announceSearching, withdrawSearching } from '../lobbies/discordAnnounce';
import { finalizeRoom } from '../lobbies/discordAnnounce';
import { noteLobbiesChanged } from '../global/lobbiesChanged';
import type { MmPenalty, MmPlayerState, MmProfile, MmStore } from './Matchmaker';
import type { MmPlayKind, MmTicket } from './pairing';

/** The title of a matched room. English, like every network value the launcher titles a room with. */
export function matchedRoomTitle(names: readonly string[], kind: MmPlayKind): string {
    const label = kind === 'ranked' ? 'Quick match 1v1' : 'Casual quick match 1v1';
    const who = names.map((n) => (n || 'Player').slice(0, 24)).join(' vs ');
    return `${label} · ${who}`;
}

export function dbStore(ctx: AppContext): MmStore {
    return {
        async playerState(userId: string): Promise<MmPlayerState> {
            const row = await ctx.db.prepare(
                `SELECT l.status AS status FROM lobby_members m JOIN lobbies l ON l.id = m.lobby_id
                  WHERE m.user_id = ? AND l.status IN ('open','locked','in_game')
                  ORDER BY CASE l.status WHEN 'in_game' THEN 0 ELSE 1 END LIMIT 1`,
            ).bind(userId).first<{ status: string }>();
            return { inRoom: !!row && row.status !== 'in_game', inGame: row?.status === 'in_game' };
        },

        async rating(userId: string) {
            const r = (await effectiveRatings(ctx.db, [userId], 'default')).get(userId);
            const games = r?.games_played ?? 0;
            return { rating: r?.rating ?? 1500, placing: isInPlacement(games, 'default') };
        },

        async profile(userId: string): Promise<MmProfile> {
            const [u, ranks, modes, r] = await Promise.all([
                ctx.db.prepare(
                    `SELECT display_name, discord_username, avatar_url FROM users WHERE id = ?`,
                ).bind(userId).first<{ display_name: string | null; discord_username: string; avatar_url: string | null }>(),
                ladderRanks(ctx, [userId], 'default'),
                badgeModes(ctx, [userId]),
                effectiveRatings(ctx.db, [userId], 'default').catch(() => new Map()),
            ]);
            return {
                displayName: u?.display_name || u?.discord_username || 'Player',
                avatarUrl: u?.avatar_url ?? null,
                ladderRank: ranks.get(userId),
                badgeMode: modes.get(userId),
                gamesPlayed: (r.get(userId) as { games_played?: number } | undefined)?.games_played ?? 0,
            };
        },

        isRankedMod(modId: string): boolean {
            return isRankedMod(ctx.config.rankedModIds, modId);
        },

        async penalty(userId: string): Promise<MmPenalty> {
            const row = await ctx.db.prepare(
                `SELECT strikes, last_strike_at, locked_until FROM matchmaking_penalties WHERE user_id = ?`,
            ).bind(userId).first<{ strikes: number; last_strike_at: number; locked_until: number }>();
            return {
                strikes: row?.strikes ?? 0,
                lastStrikeAt: row?.last_strike_at ?? 0,
                lockedUntil: row?.locked_until ?? 0,
            };
        },

        async savePenalty(userId: string, p: MmPenalty): Promise<void> {
            await ctx.db.prepare(
                `INSERT INTO matchmaking_penalties (user_id, strikes, last_strike_at, locked_until)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT (user_id) DO UPDATE SET strikes = excluded.strikes,
                     last_strike_at = excluded.last_strike_at, locked_until = excluded.locked_until`,
            ).bind(userId, p.strikes, p.lastStrikeAt, p.lockedUntil).run();
        },

        async openRoom(input) {
            const created = await createLobby(ctx, input.hostUserId, {
                title: matchedRoomTitle(input.names, input.kind),
                titleMax: 120,
                modId: input.modId,
                modCombinedHash: input.modHash,
                maxPlayers: 2,
                askedCompetitive: input.kind === 'ranked',
                announce: false,
                matchmakingMatchId: input.matchId,
            });
            // The whitelist the join reads (rest.ts). Written after the room exists: until a
            // row is here nobody but the host is in, which is the safe direction.
            await ctx.db.batch(input.players.map((uid) => ctx.db.prepare(
                `INSERT OR IGNORE INTO matchmaking_match_players (match_id, user_id) VALUES (?, ?)`,
            ).bind(input.matchId, uid)));
            return { lobbyId: created.id, competitive: created.competitive };
        },

        async roomState(lobbyId: string) {
            const l = await ctx.db.prepare(`SELECT status FROM lobbies WHERE id = ?`)
                .bind(lobbyId).first<{ status: string }>();
            const m = await ctx.db.prepare(`SELECT user_id FROM lobby_members WHERE lobby_id = ?`)
                .bind(lobbyId).all<{ user_id: string }>();
            return { status: l?.status ?? null, members: (m.results ?? []).map((r) => r.user_id) };
        },

        async closeRoom(lobbyId: string): Promise<void> {
            await ctx.db.batch([
                ctx.db.prepare(
                    `UPDATE lobbies SET status='closed', closed_at=datetime('now')
                      WHERE id = ? AND status IN ('open','locked')`,
                ).bind(lobbyId),
                ctx.db.prepare(`DELETE FROM lobby_members WHERE lobby_id = ?`).bind(lobbyId),
            ]);
            ctx.rooms.close(lobbyId);
            finalizeRoom(lobbyId);
            noteLobbiesChanged();
            ctx.globalChat.refreshPlayers();
        },

        announceSearching(ticket: MmTicket, profile: MmProfile): void {
            if (ctx.config.discordWebhookUrls.length === 0) return;
            void announceSearching({
                ticketId: ticket.id,
                modId: ticket.modId,
                playerName: profile.displayName,
                playerAvatar: profile.avatarUrl,
                competitive: ticket.kind !== 'casual',
                queuedAt: ticket.queuedAt,
            });
        },

        withdrawSearching(ticketId: string): void {
            void withdrawSearching(ticketId);
        },
    };
}
