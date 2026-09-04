import type { FastifyInstance } from 'fastify';
import { Errors } from '../lib/errors';
import { sha256Hex, uuid } from '../lib/ids';
import { requireAuth, requireLauncherVersion } from '../middleware/auth';
import { ipRateLimit, userRateLimit, Limits } from '../middleware/rateLimit';
import { finalizeRoom } from './discordAnnounce';
import { createLobby } from './create';
import { isEntrantMember } from '../tournaments/store';
import { DEFAULT_RATING, DEFAULT_RD } from '../elo/glicko2';
import type { AppContext } from '../context';

interface LobbyRow {
    id: string;
    host_user_id: string;
    title: string;
    mod_id: string;
    mod_combined_hash: string;
    max_players: number;
    /** How many of `max_players` are watching rather than playing. 0 for every older room. */
    spectator_slots: number;
    current_players: number;
    is_private: number;
    password_hash: string | null;
    status: 'open' | 'locked' | 'in_game' | 'closed';
    created_at: string;
    competitive: number;
    /** The bracket slot this room plays out, or null. Written only by the tournament route. */
    tournament_match_id: string | null;
}

interface CreateLobbyBody {
    title: string;
    mod_id: string;
    mod_combined_hash: string;
    max_players?: number;
    /**
     * How many of `max_players` are seats for watchers rather than players.
     *
     * A request. Clamped in `createLobby` and echoed back as the effective value, the same
     * way `competitive` is — the client must not be able to decide either, and it learns
     * what it actually got from the 201 rather than from a copy of the rule.
     */
    spectator_slots?: number;
    password?: string;
    /** Whether the host is putting rating on this match. Clamped below — see the insert. */
    competitive?: boolean;
}

interface JoinLobbyBody {
    mod_combined_hash: string;
    password?: string;
    /**
     * Take one of the room's watching seats instead of a playing one.
     *
     * Refused when the room has none free — never quietly downgraded to a player seat. A
     * caster who is silently seated as a player is a caster who starts the game with a town
     * centre in a match that is now 3v2.
     */
    as_spectator?: boolean;
}

/**
 * Mount /lobbies/* on the Fastify instance. Direct port of the original
 * Hono router with the same routes, same SQL, same response shapes —
 * the launcher's <c>LobbyApiClient</c> can't tell which backend it's
 * talking to.
 */
export function registerLobbiesRest(app: FastifyInstance, ctx: AppContext): void {
    // GET /lobbies — public list.
    app.get('/lobbies', {
        preHandler: [ipRateLimit(ctx, Limits.LobbyListIp)],
    }, async (_req, reply) => {
        const rows = await ctx.db.prepare(
            `SELECT l.id, l.host_user_id, l.title, l.mod_id, l.mod_combined_hash,
                    l.max_players, l.spectator_slots, l.current_players, l.is_private,
                    l.status, l.competitive, l.tournament_match_id,
                    -- Counted rather than denormalised, unlike current_players. This is read
                    -- once per row on a list capped at 100 and covered by lobby_members' own
                    -- primary key; a second denormalised counter would be a second thing that
                    -- can drift out of step with the roster, and the first one already has a
                    -- comment in LobbyRoom about never decrementing.
                    (SELECT COUNT(*) FROM lobby_members m
                      WHERE m.lobby_id = l.id AND m.role = 'spectator') AS spectators_present,
                    l.created_at, u.discord_username AS host_login, u.display_name AS host_name,
                    u.avatar_url AS host_avatar, e.rating AS host_rating, e.rd AS host_rd
             FROM lobbies l
             JOIN users u ON u.id = l.host_user_id
             -- LEFT, and it has to stay LEFT. This is the rooms list: with an inner
             -- join every room whose host has no rating row would VANISH from it, which
             -- is a far worse bug than a missing number and a silent one. Same trap as
             -- the membership query in LobbyRoom's hello.
             LEFT JOIN elo_ratings e ON e.user_id = l.host_user_id AND e.mode = 'default'
             WHERE l.status IN ('open', 'locked', 'in_game')
             ORDER BY l.created_at DESC
             LIMIT 100`,
        ).bind().all<{
            id: string;
            host_user_id: string;
            title: string;
            mod_id: string;
            mod_combined_hash: string;
            max_players: number;
            spectator_slots: number;
            spectators_present: number;
            current_players: number;
            is_private: number;
            status: 'open' | 'locked' | 'in_game';
            competitive: number;
            tournament_match_id: string | null;
            created_at: string;
            host_login: string;
            host_name: string;
            host_avatar: string | null;
            host_rating: number | null;
            host_rd: number | null;
        }>();

        reply.header('Cache-Control', 'public, max-age=5');
        return reply.send({
            lobbies: (rows.results ?? []).map((r) => ({
                id: r.id,
                title: r.title,
                mod_id: r.mod_id,
                mod_combined_hash: r.mod_combined_hash,
                max_players: r.max_players,
                // Seats that are not players. The launcher subtracts this before reading a
                // format off the size, so a 2v2 with a caster is five seats and still a 2v2.
                spectator_slots: r.spectator_slots,
                // How many of current_players are watching. The row subtracts it to learn
                // how many PLAYING seats are taken, which is what decides whether its button
                // offers a seat at the game or a seat beside it.
                spectators_present: r.spectators_present,
                current_players: r.current_players,
                is_private: r.is_private === 1,
                status: r.status,
                // Before joining, not after: this is what tells a player their rating is
                // on the line and that leaving the room will not be free.
                competitive: r.competitive === 1,
                // Null for an ordinary room. Lets the rooms table show a tournament chip
                // and hide Join from anyone who is not one of the two entrants.
                tournament_match_id: r.tournament_match_id ?? null,
                created_at: r.created_at,
                host: {
                    id: r.host_user_id,
                    discord_username: r.host_login,
                    display_name: r.host_name,
                    avatar_url: r.host_avatar,
                    // No row means UNRATED, and unrated is the starting rating — the
                    // server is the only side that can tell that apart from "I could not
                    // answer", because it ran the query. Sending null for it made the
                    // rooms list show no rating at all for everybody, since the ratings
                    // reset left nobody with a row.
                    //
                    // The comment here used to claim the launcher substituted this value
                    // itself. It does not: RatingDisplay.ShouldShow is `rating.HasValue`.
                    // Filling it in on the client would be wrong anyway — it cannot tell
                    // an unrated player from a server that did not send the field.
                    rating: r.host_rating ?? DEFAULT_RATING,
                    // The deviation goes WITH it, and without it the rating is ambiguous: the
                    // client had no way to tell a 1500 nobody has played for from one somebody
                    // landed on, so both read the same. Same default as the rating, for the
                    // same reason — a player with no row is unrated, which is what 350 means.
                    rd: r.host_rd ?? DEFAULT_RD,
                },
            })),
        });
    });

    // POST /lobbies — create.
    app.post('/lobbies', {
        preHandler: [
            requireAuth(),
            // Entry only. See Config.minLauncherVersion for what is deliberately NOT gated.
            requireLauncherVersion(ctx),
            ipRateLimit(ctx, Limits.LobbyCreateIp),
            userRateLimit(ctx, Limits.LobbyCreateUser),
        ],
    }, async (req, reply) => {
        // The whole of this used to live here. It moved to `createLobby` so the tournament
        // route can open a room by exactly these rules rather than growing a second copy
        // of them — see the header of ./create.ts for what "exactly these rules" covers.
        const body = (req.body ?? {}) as CreateLobbyBody;
        const created = await createLobby(ctx, req.userId!, {
            title: body.title,
            modId: body.mod_id,
            modCombinedHash: body.mod_combined_hash,
            maxPlayers: body.max_players,
            spectatorSlots: body.spectator_slots,
            password: body.password,
            askedCompetitive: body.competitive,
        });
        return reply.code(201).send(created);
    });

    // GET /lobbies/:id — details with members.
    app.get('/lobbies/:id', {
        preHandler: [ipRateLimit(ctx, Limits.LobbyListIp)],
    }, async (req, reply) => {
        const lobbyId = (req.params as { id: string }).id;
        const lobby = await ctx.db.prepare(
            `SELECT * FROM lobbies WHERE id = ?`,
        ).bind(lobbyId).first<LobbyRow>();
        if (!lobby || lobby.status === 'closed') throw Errors.NotFound('Lobby');

        const members = await ctx.db.prepare(
            `SELECT lm.user_id, lm.is_ready, lm.role, u.discord_username, u.display_name, u.avatar_url
             FROM lobby_members lm
             JOIN users u ON u.id = lm.user_id
             WHERE lm.lobby_id = ?
             ORDER BY lm.joined_at ASC`,
        ).bind(lobbyId).all<{
            user_id: string;
            is_ready: number;
            role: 'player' | 'spectator';
            discord_username: string;
            display_name: string;
            avatar_url: string | null;
        }>();

        return reply.send({
            id: lobby.id,
            title: lobby.title,
            mod_id: lobby.mod_id,
            mod_combined_hash: lobby.mod_combined_hash,
            max_players: lobby.max_players,
            spectator_slots: lobby.spectator_slots,
            current_players: lobby.current_players,
            is_private: lobby.is_private === 1,
            status: lobby.status,
            competitive: lobby.competitive === 1,
            tournament_match_id: lobby.tournament_match_id ?? null,
            host_user_id: lobby.host_user_id,
            members: (members.results ?? []).map((m) => ({
                id: m.user_id,
                discord_username: m.discord_username,
                display_name: m.display_name,
                avatar_url: m.avatar_url,
                is_ready: m.is_ready === 1,
                role: m.role,
            })),
        });
    });

    // POST /lobbies/:id/join — pre-join check + WS join token.
    app.post('/lobbies/:id/join', {
        preHandler: [
            requireAuth(),
            requireLauncherVersion(ctx),
            ipRateLimit(ctx, Limits.LobbyJoinIp),
            userRateLimit(ctx, Limits.LobbyJoinUser),
        ],
    }, async (req, reply) => {
        const userId = req.userId!;
        const lobbyId = (req.params as { id: string }).id;
        const body = (req.body ?? {}) as JoinLobbyBody;
        if (!body.mod_combined_hash) throw Errors.BadRequest('mod_combined_hash required');

        const lobby = await ctx.db.prepare(
            `SELECT * FROM lobbies WHERE id = ?`,
        ).bind(lobbyId).first<LobbyRow>();
        if (!lobby || lobby.status === 'closed') throw Errors.NotFound('Lobby');
        if (lobby.status === 'in_game') throw Errors.Conflict('Lobby already in game.');

        // A room bound to a bracket slot is not a public room. Checked HERE, beside the
        // other status-shaped refusals and BEFORE the password branch, so a stranger
        // cannot learn from the error whether a tournament room is password-protected.
        //
        // Membership is read from the FROZEN roster, so a saved team that drops a player
        // after entering cannot lock that player out of a match they are registered for.
        if (lobby.tournament_match_id) {
            const mine = await isEntrantMember(ctx.db, lobby.tournament_match_id, userId);
            if (!mine) throw Errors.NotTournamentParticipant();
        }
        // Seats fill by ROLE, not by total. A room of five with one watching seat has four
        // player seats and one observer seat, and they run out independently: checking only
        // the total would let a fifth player in and lock the caster out of the room that was
        // widened for them.
        const seated = await ctx.db.prepare(
            `SELECT
                 SUM(CASE WHEN role = 'spectator' THEN 1 ELSE 0 END) AS watching,
                 SUM(CASE WHEN role = 'spectator' THEN 0 ELSE 1 END) AS playing
             FROM lobby_members WHERE lobby_id = ?`,
        ).bind(lobbyId).first<{ watching: number | null; playing: number | null }>();
        const watching = seated?.watching ?? 0;
        const playing = seated?.playing ?? 0;

        const asSpectator = body.as_spectator === true;
        if (asSpectator) {
            // Refused rather than downgraded to a player seat. Someone who asked to watch and
            // is quietly seated as a player starts the game with a town centre, in a match
            // that is now uneven and that nobody realises is uneven until it is over.
            if (watching >= lobby.spectator_slots) throw Errors.LobbyFull();
        } else if (playing >= lobby.max_players - lobby.spectator_slots) {
            throw Errors.LobbyFull();
        }

        if (lobby.is_private === 1) {
            if (!body.password) throw Errors.Forbidden();
            const ph = await sha256Hex(body.password);
            if (ph !== lobby.password_hash) throw Errors.Forbidden();
        }

        if (lobby.mod_combined_hash !== body.mod_combined_hash) {
            throw Errors.ModMismatch({
                expected: lobby.mod_combined_hash,
                got: body.mod_combined_hash,
                mod_id: lobby.mod_id,
            });
        }

        const inOther = await ctx.db.prepare(
            `SELECT lobby_id FROM lobby_members
             WHERE user_id = ? AND lobby_id != ?
             LIMIT 1`,
        ).bind(userId, lobbyId).first();
        if (inOther) throw Errors.AlreadyInLobby();

        await ctx.db.batch([
            ctx.db.prepare(
                // The role is written on re-join too: someone who left a player seat and came
                // back to watch must not keep the seat they gave up. is_ready is cleared for
                // the same reason it always was - a returning member has not agreed to
                // anything about the room as it now stands.
                `INSERT INTO lobby_members (lobby_id, user_id, role)
                 VALUES (?, ?, ?)
                 ON CONFLICT (lobby_id, user_id) DO UPDATE SET is_ready = 0, role = excluded.role`,
            ).bind(lobbyId, userId, asSpectator ? 'spectator' : 'player'),
            ctx.db.prepare(
                `UPDATE lobbies SET current_players = (
                    SELECT COUNT(*) FROM lobby_members WHERE lobby_id = ?
                 ) WHERE id = ?`,
            ).bind(lobbyId, lobbyId),
        ]);

        const joinToken = uuid();
        await ctx.kv.put(
            `lobby:join:${joinToken}`,
            JSON.stringify({ userId, lobbyId }),
            { expirationTtl: 120 },
        );

        return reply.send({
            lobby_id: lobbyId,
            join_token: joinToken,
            ws_url: `/lobbies/${lobbyId}/ws`,
        });
    });

    // POST /lobbies/:id/leave.
    app.post('/lobbies/:id/leave', {
        preHandler: [requireAuth(), ipRateLimit(ctx, Limits.LobbyJoinIp)],
    }, async (req, reply) => {
        const userId = req.userId!;
        const lobbyId = (req.params as { id: string }).id;

        const lobby = await ctx.db.prepare(
            `SELECT * FROM lobbies WHERE id = ?`,
        ).bind(lobbyId).first<LobbyRow>();
        if (!lobby) throw Errors.NotFound('Lobby');

        const isHost = lobby.host_user_id === userId;
        if (isHost) {
            // GameRanger-style migration: instead of closing the lobby when the
            // host leaves, drop the host's membership, recompute the count, then
            // hand the lobby to the next LIVE member by join order. Only close if
            // nobody live remains to inherit. (reassignHost excludes the leaver
            // and is idempotent with the ws-close path, whichever fires first.)
            await ctx.db.batch([
                ctx.db.prepare(
                    `DELETE FROM lobby_members WHERE lobby_id = ? AND user_id = ?`,
                ).bind(lobbyId, userId),
                ctx.db.prepare(
                    `UPDATE lobbies SET current_players = (
                        SELECT COUNT(*) FROM lobby_members WHERE lobby_id = ?
                     ) WHERE id = ?`,
                ).bind(lobbyId, lobbyId),
            ]);
            const room = ctx.rooms.get(lobbyId);
            const migrated = room ? await room.reassignHost(ctx, userId) : false;
            if (!migrated) {
                await ctx.db.prepare(
                    `UPDATE lobbies SET status='closed', closed_at=datetime('now') WHERE id = ?`,
                ).bind(lobbyId).run();
                ctx.rooms.close(lobbyId);
                finalizeRoom(lobbyId);
            }
        } else {
            await ctx.db.batch([
                ctx.db.prepare(
                    `DELETE FROM lobby_members WHERE lobby_id = ? AND user_id = ?`,
                ).bind(lobbyId, userId),
                ctx.db.prepare(
                    `UPDATE lobbies SET current_players = (
                        SELECT COUNT(*) FROM lobby_members WHERE lobby_id = ?
                     ) WHERE id = ?`,
                ).bind(lobbyId, lobbyId),
            ]);
        }
        // Membership changed (leave / host-close) — refresh the players panel.
        ctx.globalChat.refreshPlayers();
        return reply.send({ ok: true });
    });
}
