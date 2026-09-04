/**
 * Creating a room, extracted from `POST /lobbies` so more than one caller can do it.
 *
 * ---------------------------------------------------------------------------
 * Why this moved out of the route
 * ---------------------------------------------------------------------------
 * A tournament match is played in an ordinary competitive room. The alternative to this
 * extraction was a second creation path in the tournaments route, and a second path is
 * how the two come to disagree: this one force-closes the host's previous room, checks
 * the server-wide budget, clamps `competitive` against the ranked-mod list AND the 2/4/6
 * size rule, pre-creates the in-memory room so the host's socket doesn't race, and
 * announces to two different channels. Any of those quietly missing from a tournament
 * room would be a bug nobody sees until a real match.
 *
 * `grep "INSERT INTO lobbies"` over `src/` returns exactly one hit — the one below. That
 * is the property worth keeping, and it is the whole point of this file.
 *
 * ---------------------------------------------------------------------------
 * What it must never import
 * ---------------------------------------------------------------------------
 * Nothing from `src/tournaments/*`. The tournament binding arrives as a plain
 * `tournamentMatchId` parameter and this file never looks a bracket up, which is what
 * keeps `tournaments/rest.ts → create.ts` from becoming a cycle. Same rule the
 * `attachGlobalChat` shim in LobbyRoom.ts exists for.
 *
 * `discordAnnounce` is safe to import (it is a leaf: it imports nothing from this
 * directory), and the room registry and global chat arrive through `ctx` rather than as
 * value imports, so there is no runtime edge to `LobbyRoom.ts` or `GlobalChatRoom.ts`.
 */
import { Errors } from '../lib/errors';
import { shortId, sha256Hex } from '../lib/ids';
import { announceLobbyCreated, finalizeRoom } from './discordAnnounce';
import type { AppContext } from '../context';

/**
 * PLAYING sizes that may be competitive.
 *
 * A competitive room's playing size is what names its format — 2 seats is 1v1, 4 is 2v2, 6
 * is 3v3 — so the launcher reads the format off it instead of sending one. That only holds
 * if no other size can be competitive, and enforcing it is this side's job: the client is
 * exactly what an attacker controls, and a competitive room of 8 would leave a match
 * whose format nothing can name.
 *
 * "Playing" is `max_players - spectator_slots`, because an observer sits in a real map slot
 * and is counted by `max_players` like anyone else. Before that subtraction a 2v2 with one
 * observer was five seats, matched nothing here, and was quietly downgraded to casual — the
 * game was played and the result did not score.
 */
const COMPETITIVE_SIZES = [2, 4, 6];

/**
 * The most seats a room may hand to people who are not playing.
 *
 * Two, which covers a caster and a co-caster. It is a cap and not a policy: every observer
 * still costs a real map slot, so an unbounded count would let a client create a "6v6" that
 * is one player and eleven watchers, and the map script's format detection — which reads
 * team assignments off the first six slots — would place them as if they were playing.
 */
export const MAX_SPECTATOR_SLOTS = 2;

/**
 * How many of a room's seats actually go to watchers, given what the client asked for.
 *
 * Exported and pure so it can be pinned without a database: the rest of `createLobby` needs
 * a connection, a config and an authenticated user, and this arithmetic needs none of them
 * while being the part that can silently cost somebody a rated match.
 *
 * Clamped in three directions, and the third is the one that matters: the room must be left
 * with at least two people PLAYING. Without it a client could ask for two seats and two
 * observers and open a competitive room with nobody in it.
 *
 * `Number.isFinite` is checked FIRST because NaN passes through both `Math.max` and
 * `Math.min` unchanged — it would survive every clamp here and reach the database.
 */
export function resolveSpectatorSlots(asked: unknown, maxPlayers: number): number {
    const n = typeof asked === 'number' && Number.isFinite(asked) ? Math.floor(asked) : 0;
    return Math.max(0, Math.min(MAX_SPECTATOR_SLOTS, Math.min(n, maxPlayers - 2)));
}

/**
 * The seats a room's format is read off — everything that is not an observer.
 *
 * The launcher's `RoomFormats.PlayingSeats` is the same subtraction on the other side of the
 * wire, and they have to agree: this side decides whether a room may be competitive, that
 * side decides which format to show and which rules to enforce. Disagreeing by one would
 * mean a room the server rated and the launcher could not name.
 */
export function playingSeatsOf(maxPlayers: number, spectatorSlots: number): number {
    return maxPlayers - (spectatorSlots > 0 ? spectatorSlots : 0);
}

export interface CreateLobbyInput {
    title: string;
    modId: string;
    modCombinedHash: string;
    maxPlayers?: number;
    /**
     * Seats reserved for watchers, INCLUDED in `maxPlayers` rather than added to it.
     *
     * A request, not a decision: clamped to at most MAX_SPECTATOR_SLOTS and to leaving at
     * least two people playing, then echoed back. Absent means 0, which is what every
     * existing client sends and what every existing room has.
     */
    spectatorSlots?: number;
    password?: string;
    /** A request, not a decision. Clamped below; the result is echoed back. */
    askedCompetitive?: boolean;
    /**
     * The bracket slot this room plays out, or null for an ordinary room.
     *
     * Only `POST /tournaments/:id/matches/:mid/lobby` passes this. It is written to the
     * row so `POST /matches` can read it off the LOBBY rather than off the report — the
     * same rule as `competitive`, and for the same reason: the client must not be able to
     * claim that whatever it just played was a tournament match.
     */
    tournamentMatchId?: string | null;
    /**
     * Whether to tell anybody. False for tournament rooms.
     *
     * It suppresses BOTH channels — the in-app `lobby_created` toast that every connected
     * launcher receives, and the Discord webhook. A round that opens eight rooms at once
     * would otherwise fire eight role-pinged embeds and eight toasts, which is the single
     * thing that would make raising MAX_ACTIVE_GAMES unpleasant rather than harmless.
     *
     * The room is still listed by `GET /lobbies` with its tournament chip; this is about
     * push, not visibility.
     */
    announce?: boolean;
}

/** Exactly the body `POST /lobbies` has always returned with its 201. */
export interface CreatedLobby {
    id: string;
    title: string;
    mod_id: string;
    mod_combined_hash: string;
    max_players: number;
    /**
     * How many of `max_players` are watching rather than playing. The EFFECTIVE value after
     * clamping, which is how the launcher learns that its request was cut down without
     * holding a copy of the rule.
     */
    spectator_slots: number;
    current_players: number;
    is_private: boolean;
    status: 'open';
    competitive: boolean;
    /** Null for an ordinary room. Additive: old launchers ignore it. */
    tournament_match_id: string | null;
}

export async function createLobby(
    ctx: AppContext,
    userId: string,
    input: CreateLobbyInput,
): Promise<CreatedLobby> {
    const cfg = ctx.config;

    if (!input.title || !input.modId || !input.modCombinedHash) {
        throw Errors.BadRequest('title, mod_id and mod_combined_hash are required');
    }
    const title = input.title.trim().slice(0, 80);
    if (title.length < 3) throw Errors.BadRequest('title too short');

    const maxPlayers = Math.min(
        cfg.lobbyMaxPlayers,
        Math.max(2, Number.isFinite(input.maxPlayers) ? input.maxPlayers! : cfg.lobbyMaxPlayers),
    );

    const spectatorSlots = resolveSpectatorSlots(input.spectatorSlots, maxPlayers);
    const playingSeats = playingSeatsOf(maxPlayers, spectatorSlots);

    await closePreviousRooms(ctx, userId);

    const active = await ctx.db.prepare(
        `SELECT COUNT(*) AS n FROM lobbies WHERE status IN ('open','locked','in_game')`,
    ).bind().first<{ n: number }>();
    if ((active?.n ?? 0) >= cfg.maxActiveGames) {
        throw Errors.Conflict('Server full — max concurrent lobbies reached.');
    }

    // Competitive is a PROMISE — only this room's matches score, and the launcher holds
    // the player to it (confirming Record Game, refusing to let the host leave before the
    // result is in). A mod with no ladder cannot keep that promise, so the room is created
    // casual instead of failing. The response echoes the EFFECTIVE value, which is how the
    // launcher explains the downgrade without holding a copy of the ranked-mod list —
    // that policy lives here and nowhere else.
    const askedCompetitive = input.askedCompetitive === true;
    const modKey = input.modId.trim().toLowerCase();
    const competitive = askedCompetitive
        && cfg.rankedModIds.some((m) => m === modKey)
        && COMPETITIVE_SIZES.includes(playingSeats)
        ? 1 : 0;

    const lobbyId = shortId(8);
    const passwordHash = input.password ? await sha256Hex(input.password) : null;
    const isPrivate = passwordHash ? 1 : 0;
    const tournamentMatchId = input.tournamentMatchId ?? null;

    await ctx.db.batch([
        ctx.db.prepare(
            // created_by is written once and never updated — that is the whole point of
            // it. host_user_id moves to whoever inherits the room, so it is the only
            // record of who actually opened it, which is what the Discord embed names.
            `INSERT INTO lobbies (id, host_user_id, created_by, title, mod_id, mod_combined_hash,
                                  max_players, current_players, is_private, password_hash,
                                  status, competitive, tournament_match_id, spectator_slots)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'open', ?, ?, ?)`,
        ).bind(
            lobbyId, userId, userId, title, input.modId, input.modCombinedHash,
            maxPlayers, isPrivate, passwordHash, competitive, tournamentMatchId, spectatorSlots,
        ),
        ctx.db.prepare(
            `INSERT INTO lobby_members (lobby_id, user_id, role) VALUES (?, ?, 'player')`,
        ).bind(lobbyId, userId),
    ]);

    // Pre-create the in-memory room so the host's WS upgrade doesn't race against an
    // empty registry.
    ctx.rooms.getOrCreate(lobbyId, userId);

    // The creator is now "in a room" — refresh the global players panel.
    ctx.globalChat.refreshPlayers();

    // Announce the new room — both to the in-app global toast (every connected launcher)
    // and to Discord (only if a webhook is configured). BOTH skip private rooms, and both
    // skip rooms created with `announce: false`. Best-effort: the Discord one is never
    // awaited so it can't add latency, and each swallows its own errors internally.
    if (isPrivate === 0 && input.announce !== false) {
        const host = await ctx.db.prepare(
            `SELECT display_name, discord_username, avatar_url FROM users WHERE id = ?`,
        ).bind(userId).first<{
            display_name: string;
            discord_username: string;
            avatar_url: string | null;
        }>();
        const hostName = host?.display_name || host?.discord_username || 'Unknown';
        const hostAvatar = host?.avatar_url ?? null;

        ctx.globalChat.announceLobbyCreated({
            id: lobbyId, title, modId: input.modId, maxPlayers,
            hostUserId: userId, hostName, hostAvatar,
            competitive: competitive === 1,
        });

        if (cfg.discordWebhookUrls.length > 0) {
            void announceLobbyCreated({
                id: lobbyId, title, modId: input.modId, maxPlayers,
                isPrivate: false, hostName, hostAvatar,
                competitive: competitive === 1,
            });
        }
    }

    return {
        id: lobbyId,
        title,
        mod_id: input.modId,
        mod_combined_hash: input.modCombinedHash,
        max_players: maxPlayers,
        spectator_slots: spectatorSlots,
        current_players: 1,
        is_private: isPrivate === 1,
        status: 'open',
        competitive: competitive === 1,
        tournament_match_id: tournamentMatchId,
    };
}

/**
 * Force-close whatever this user was hosting — "create new = implicit leave previous".
 *
 * Runs BEFORE the server-wide capacity check, and that order is load-bearing: a host
 * recreating a room must not have their own dying room counted against the budget.
 *
 * ---------------------------------------------------------------------------
 * The tournament exception
 * ---------------------------------------------------------------------------
 * This loop is unconditional and silent: it closes rooms that are mid-GAME and evicts
 * every member, with no error surfacing to anybody. That is tolerable for a casual room
 * whose host wandered off and clicked Create again. It is not tolerable for a tournament
 * match, where it would destroy a game two people are playing and leave the bracket
 * waiting for a result that can never arrive.
 *
 * So a room bound to a bracket slot that is STILL PENDING refuses instead, and the caller
 * gets a 409 naming it.
 *
 * **The `pending` half of that condition is what stops this becoming a permanent
 * lockout.** Once the bracket slot is decided the room is just a leftover and is closed
 * like any other. Without that, one stale binding would bar the player from creating any
 * room ever again — which is precisely the failure that stale `lobby_members` rows already
 * cause on the join path, and the reason `player:unstick` had to be invented.
 *
 * Protecting is not making immortal. Three other paths still close these rooms and none
 * of them changes: the startup orphan sweep, the close when no live socket remains, and
 * the automatic close when the match is reported.
 */
async function closePreviousRooms(ctx: AppContext, userId: string): Promise<void> {
    // Keys on host_user_id rather than created_by, so a room this user INHERITED through
    // host migration is closed too. That is deliberate and predates tournaments.
    const stale = await ctx.db.prepare(
        `SELECT l.id, l.title, l.tournament_match_id, tm.status AS tournament_match_status
           FROM lobbies l
           LEFT JOIN tournament_matches tm ON tm.id = l.tournament_match_id
          WHERE l.host_user_id = ? AND l.status IN ('open','locked','in_game')`,
    ).bind(userId).all<{
        id: string;
        title: string;
        tournament_match_id: string | null;
        tournament_match_status: string | null;
    }>();

    for (const row of stale.results ?? []) {
        if (row.tournament_match_id && row.tournament_match_status === 'pending') {
            // Names the room, because a 409 that only says "conflict" is indistinguishable
            // from being stuck. Leaving the room is the way out and the launcher has that
            // button already.
            throw Errors.Conflict(
                `You still have a tournament match room open ("${row.title}"). `
                + 'Finish or leave it before creating another room.',
            );
        }

        await ctx.db.batch([
            ctx.db.prepare(
                `UPDATE lobbies SET status='closed', closed_at=datetime('now') WHERE id = ?`,
            ).bind(row.id),
            ctx.db.prepare(
                `DELETE FROM lobby_members WHERE lobby_id = ?`,
            ).bind(row.id),
        ]);
        ctx.rooms.close(row.id);
        finalizeRoom(row.id);
    }
}
