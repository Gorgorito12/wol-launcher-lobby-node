/**
 * The tournament HTTP surface: public reads, entrant actions, owner actions.
 *
 * ---------------------------------------------------------------------------
 * Permission model
 * ---------------------------------------------------------------------------
 * There is no role anywhere. Anybody signed in may create a tournament and becomes its
 * OWNER, with every power over that tournament and none over anybody else's. The guard is
 * `requireTournamentOwner`, which reads `tournaments.owner_user_id` — the same shape as
 * `lobbies.host_user_id` gating kick and start.
 *
 * One power is deliberately absent: **there is no route that undoes a played result.**
 * Voiding a match that a recording decided touches the anti-cheat story and the ladder, so
 * it stays in the maintainer's CLI where a dry run and a snapshot exist.
 *
 * ---------------------------------------------------------------------------
 * What anybody-can-create costs, and what pays for it
 * ---------------------------------------------------------------------------
 * With no moderator, the brakes are quantitative: a per-user cap on live tournaments, a
 * server-wide cap, a deliberately tiny creation rate limit, a clamped capacity, and a name
 * that is trimmed and length-bounded. A user-created tournament is also never announced to
 * Discord — the role ping is the obvious thing to abuse — which is why `featured` exists
 * and only the CLI sets it.
 *
 * ---------------------------------------------------------------------------
 * Scope of this file today
 * ---------------------------------------------------------------------------
 * Everything below is written in terms of ENTRANTS, which are teams of one in a 1v1. Only
 * creation is restricted to `1v1` / `solo` for now; opening the team formats later is
 * loosening one validation rather than rewriting routes.
 */
import type { FastifyInstance } from 'fastify';
import { Errors } from '../lib/errors';
import { uuid, shortId } from '../lib/ids';
import { requireAuth, requireTournamentOwner } from '../middleware/auth';
import { ipRateLimit, userRateLimit, Limits } from '../middleware/rateLimit';
import { createLobby } from '../lobbies/create';
import type { AppContext } from '../context';

import {
    validateRoster, entryStatusFor, promoteFromWaitlist, playsInBracket,
    seedByRating, seedByExplicitOrder, teamSourceAllowed, rosterSizeFor,
    type TournamentFormat, type TeamSource, type WaitlistCandidate,
} from './entrants';
import { generateBracket, advance, disqualify, roundsFor, bracketSize } from './bracket';
import * as store from './store';
import * as teams from '../teams/store';

// ---------------------------------------------------------------- bounds

/**
 * Slots a tournament may offer, counted in ENTRANTS.
 *
 * Sixteen is not arbitrary. A 16-entrant first round is eight simultaneous rooms, and
 * MAX_ACTIVE_GAMES is 16 for the whole server — so one tournament of this size already
 * takes half of it. Offering 32 would be offering a bracket the server cannot host.
 */
const MIN_CAPACITY = 2;
const MAX_CAPACITY = 16;
const DEFAULT_CAPACITY = 8;

/** Live tournaments one person may own at once. Stale ones do not count — see lifecycle.ts. */
const MAX_OWNED_LIVE = 2;

/** Live tournaments the whole server may have. Env-tunable would need a restart anyway. */
const MAX_LIVE_TOURNAMENTS = 10;

const LIST_LIMIT = 50;
const NAME_MAX = 80;
const NAME_MIN = 3;

const CACHE_TTL_MS = 60_000;

/**
 * The detail memo, capped.
 *
 * The four memos in `stats/rest.ts` are single slots because their payloads take no
 * parameters. This one is keyed by an id the CLIENT supplies, so an uncapped Map is a
 * memory leak anybody can drive on a 1 GB box just by walking ids. Oldest-out at 50 keeps
 * the busy tournaments hot and bounds the worst case.
 */
const DETAIL_CACHE_MAX = 50;
const detailCache = new Map<string, { at: number; payload: unknown }>();

function readDetailCache(id: string): unknown | null {
    const hit = detailCache.get(id);
    if (!hit || Date.now() - hit.at >= CACHE_TTL_MS) return null;
    return hit.payload;
}

function writeDetailCache(id: string, payload: unknown): void {
    if (detailCache.size >= DETAIL_CACHE_MAX && !detailCache.has(id)) {
        // Map iterates in insertion order, so the first key is the oldest.
        const oldest = detailCache.keys().next().value;
        if (oldest !== undefined) detailCache.delete(oldest);
    }
    detailCache.set(id, { at: Date.now(), payload });
}

/** Every write must call this, or readers serve a bracket that predates the change. */
function invalidate(id: string): void {
    detailCache.delete(id);
    listCache = null;
}

let listCache: { at: number; payload: unknown } | null = null;

// ---------------------------------------------------------------- helpers

function clampCapacity(raw: unknown): number {
    const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_CAPACITY;
    return Math.min(MAX_CAPACITY, Math.max(MIN_CAPACITY, n));
}

/**
 * Validate an enum in the ROUTE, not by leaning on the schema.
 *
 * The CHECK constraints in migration 0014 would reject a bad value, but a CHECK violation
 * surfaces as a bare Error and the error handler turns anything that is not an HttpError
 * into a nameless 500. The client deserves the reason.
 */
function readEnum<T extends string>(raw: unknown, allowed: readonly T[], field: string): T {
    if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T;
    throw Errors.BadRequest(`${field} must be one of: ${allowed.join(', ')}`);
}

function paramId(req: { params: unknown }, key: string): string {
    return (req.params as Record<string, string | undefined>)[key] ?? '';
}

export function registerTournamentsRest(app: FastifyInstance, ctx: AppContext): void {
    // ------------------------------------------------------------ public reads

    app.get('/tournaments', {
        preHandler: [ipRateLimit(ctx, Limits.TournamentsIp)],
    }, async (req, reply) => {
        const now = Date.now();
        let payload = listCache && now - listCache.at < CACHE_TTL_MS ? listCache.payload : null;

        if (payload === null) {
            const rows = await store.listTournaments(ctx.db, LIST_LIMIT);
            payload = { tournaments: rows.map(listView) };
            listCache = { at: now, payload };
        }

        // The caller's own drafts, which the public list hides on purpose. A separate cheap
        // query rather than part of the memo, so the memo stays anonymous — the same split
        // /stats/community uses for its per-user flag.
        //
        // Without this the create-then-open flow is simply broken: a tournament is born a
        // draft, and the person who just made one could not find it again.
        const mine = req.userId
            ? (await store.listOwnDrafts(ctx.db, req.userId)).map(listView)
            : [];

        reply.header('Cache-Control', mine.length ? 'private, max-age=0' : 'public, max-age=60');
        return { ...(payload as object), drafts: mine };
    });

    app.get('/tournaments/:id', {
        preHandler: [ipRateLimit(ctx, Limits.TournamentsIp)],
    }, async (req, reply) => {
        const id = paramId(req, 'id');
        const cached = readDetailCache(id);
        if (cached) {
            reply.header('Cache-Control', 'public, max-age=60');
            return cached;
        }

        const payload = await buildDetail(ctx, id);
        writeDetailCache(id, payload);
        reply.header('Cache-Control', 'public, max-age=60');
        return payload;
    });

    // ------------------------------------------------------------ create

    app.post('/tournaments', {
        preHandler: [requireAuth(), userRateLimit(ctx, Limits.TournamentCreateUser)],
    }, async (req) => {
        const userId = req.userId!;
        const body = (req.body ?? {}) as {
            name?: unknown; mod_id?: unknown; format?: unknown;
            team_source?: unknown; entry_mode?: unknown; capacity?: unknown;
        };

        const name = typeof body.name === 'string' ? body.name.trim().slice(0, NAME_MAX) : '';
        if (name.length < NAME_MIN) throw Errors.BadRequest('name too short');

        const modId = typeof body.mod_id === 'string' ? body.mod_id.trim().toLowerCase() : '';
        if (!modId) throw Errors.BadRequest('mod_id is required');

        const format = readEnum<TournamentFormat>(body.format ?? '1v1', ['1v1', '2v2', '3v3'], 'format');
        const teamSource = readEnum<TeamSource>(
            body.team_source ?? 'solo', ['solo', 'registered', 'adhoc', 'draft'], 'team_source');
        const entryMode = readEnum(body.entry_mode ?? 'open', ['open', 'approval'] as const, 'entry_mode');

        if (!teamSourceAllowed(format, teamSource)) {
            throw Errors.BadRequest(`team_source ${teamSource} is not valid for a ${format}`);
        }

        // A ranked mod is not required — an unranked one simply produces casual rooms — but
        // saying so is the server's job, and the response echoes what was actually made.
        const ranked = ctx.config.rankedModIds.some((m) => m === modId);

        const owned = await store.countOwnedLive(ctx.db, userId);
        if (owned >= MAX_OWNED_LIVE) throw Errors.TournamentLimitReached(MAX_OWNED_LIVE);

        const live = await store.countAllLive(ctx.db);
        if (live >= MAX_LIVE_TOURNAMENTS) {
            throw Errors.Conflict('Server full — too many tournaments running.');
        }

        const id = shortId(8);
        await store.insertTournament(ctx.db, {
            id, name, modId, ownerUserId: userId,
            format, teamSource, entryMode, capacity: clampCapacity(body.capacity),
        });
        invalidate(id);

        const created = await store.getTournament(ctx.db, id);
        return { ...listView(created as unknown as store.TournamentListRow), ranked };
    });

    // ------------------------------------------------------------ entrant actions

    app.post('/tournaments/:id/entrants', {
        preHandler: [requireAuth(), userRateLimit(ctx, Limits.TournamentWriteUser)],
    }, async (req) => {
        const userId = req.userId!;
        const id = paramId(req, 'id');

        const t = await store.getTournament(ctx.db, id);
        if (!t) throw Errors.NotFound('Tournament');
        if (t.status !== 'registration') throw Errors.TournamentClosed();

        const body = (req.body ?? {}) as {
            member_ids?: unknown; display_name?: unknown; team_id?: unknown;
        };

        // The three ways a line-up comes to exist. All three end in the same frozen copy —
        // what differs is only where the names came from.
        let memberIds: string[];
        let teamId: string | null = null;

        if (t.format === '1v1') {
            // A 1v1 entrant is a team of one, which is what lets one bracket serve both.
            memberIds = [userId];
        } else if (t.team_source === 'registered') {
            const tid = typeof body.team_id === 'string' ? body.team_id : '';
            if (!tid) throw Errors.BadRequest('team_id required for this tournament');
            const team = await teams.getTeam(ctx.db, tid);
            if (!team || team.disbanded_at) throw Errors.NotFound('Team');
            if (team.owner_user_id !== userId) throw Errors.NotTeamCaptain();
            teamId = tid;
            // The roster is COPIED, not referenced. A saved team can drop a player tomorrow
            // and the tournament still has to remember who it accepted — the same reason
            // lobbies.roster_at_start is a snapshot.
            const roster = await teams.listMembers(ctx.db, tid);
            memberIds = roster.map((m) => m.user_id).slice(0, rosterSizeFor(t.format));
        } else if (t.team_source === 'adhoc') {
            memberIds = Array.isArray(body.member_ids)
                ? body.member_ids.filter((x): x is string => typeof x === 'string')
                : [];
        } else {
            // 'draft': everybody enters alone and the owner assembles the sides later, so a
            // registration here is a single player even though the format is a team one.
            memberIds = [userId];
        }

        if (t.format !== '1v1' && t.team_source !== 'draft' && !memberIds.includes(userId)) {
            // The captain plays. Letting somebody enter a line-up they are not in would make
            // "who may open the room" and "who is registered" two different questions.
            throw Errors.BadRequest('the captain must be in the line-up');
        }

        const already = await store.playersAlreadyEntered(ctx.db, id);
        // In draft mode people enter one at a time, so validate against a 1v1-sized roster;
        // the owner's merge is what later produces a line-up of the real size.
        const checkFormat = t.team_source === 'draft' ? '1v1' : t.format;
        const refusal = validateRoster({ format: checkFormat, memberIds, alreadyEntered: already });
        if (refusal) {
            if (refusal === 'already_entered') throw Errors.AlreadyEntered();
            throw Errors.RosterInvalid(refusal);
        }

        // Claim the seat rather than checking for one: a read-then-write cannot work here,
        // because every handler awaits in between and an await is where two registrations
        // interleave. `false` means full or closed, and in both cases the answer is the
        // waitlist. In approval mode no seat is claimed at all until the owner accepts.
        const seat = t.entry_mode === 'approval' ? false : await store.claimSeat(ctx.db, id);
        const status = entryStatusFor(t.entry_mode, seat);

        const solo = t.format === '1v1' || t.team_source === 'draft';
        const displayName = solo
            ? await displayNameOf(ctx, userId)
            : teamId
                ? (await teams.getTeam(ctx.db, teamId))?.name ?? 'Team'
                : (typeof body.display_name === 'string' && body.display_name.trim()
                    ? body.display_name.trim().slice(0, NAME_MAX)
                    : 'Team');

        const entrantId = uuid();
        await store.insertEntrant(ctx.db, {
            id: entrantId, tournamentId: id, kind: solo ? 'solo' : 'team',
            teamId, displayName, captainUserId: userId, status,
        }, memberIds);
        invalidate(id);

        return { entrant_id: entrantId, status, roster_size: rosterSizeFor(t.format) };
    });

    app.post('/tournaments/:id/entrants/:eid/withdraw', {
        preHandler: [requireAuth(), userRateLimit(ctx, Limits.TournamentWriteUser)],
    }, async (req) => {
        const userId = req.userId!;
        const id = paramId(req, 'id');
        const eid = paramId(req, 'eid');

        const t = await store.getTournament(ctx.db, id);
        if (!t) throw Errors.NotFound('Tournament');

        const e = await store.getEntrant(ctx.db, eid);
        if (!e || e.tournament_id !== id) throw Errors.NotFound('Entrant');
        // The captain withdraws the entrant. The owner has /remove for the same effect.
        if (e.captain_user_id !== userId) throw Errors.Forbidden();
        if (t.status === 'running' || t.status === 'finished') {
            throw Errors.Conflict('The bracket has already been drawn.');
        }

        await withdraw(ctx, id, e.id, e.status);
        invalidate(id);
        return { ok: true };
    });

    app.post('/tournaments/:id/matches/:mid/lobby', {
        preHandler: [requireAuth(), userRateLimit(ctx, Limits.TournamentWriteUser)],
    }, async (req, reply) => {
        const userId = req.userId!;
        const id = paramId(req, 'id');
        const mid = paramId(req, 'mid');

        const t = await store.getTournament(ctx.db, id);
        if (!t) throw Errors.NotFound('Tournament');
        if (t.status !== 'running') throw Errors.TournamentMatchNotReady();

        const bracket = await store.loadBracket(ctx.db, id);
        const m = bracket.find((x) => x.id === mid);
        if (!m) throw Errors.NotFound('Match');
        if (m.status !== 'pending' || !m.entrant1Id || !m.entrant2Id) {
            throw Errors.TournamentMatchNotReady();
        }
        if (!(await store.isEntrantMember(ctx.db, mid, userId))) {
            throw Errors.NotTournamentParticipant();
        }

        // Somebody on this match already opened it. Hand back the same room rather than a
        // second one, so both sides pressing the same button end up together.
        const existing = await store.activeLobbyForMatch(ctx.db, mid);
        if (existing) {
            return reply.code(200).send({
                id: existing.id, title: existing.title, host_user_id: existing.host_user_id,
                status: existing.status, tournament_match_id: mid, existing: true,
            });
        }

        const body = (req.body ?? {}) as { mod_combined_hash?: unknown };
        const hash = typeof body.mod_combined_hash === 'string' ? body.mod_combined_hash : '';
        if (!hash) throw Errors.BadRequest('mod_combined_hash required');

        const entrants = await store.listEntrants(ctx.db, id);
        const nameOf = (eid: string) => entrants.find((e) => e.id === eid)?.display_name ?? '?';
        const rounds = t.bracket_size ? Math.log2(t.bracket_size) : roundsFor(entrants.length);

        // The server composes the title. The client displays it and never proposes one:
        // a room name is the one string in this feature that everybody sees.
        const label = m.round >= rounds ? 'Final' : `R${m.round}`;
        const title = `${t.name} · ${label} · ${nameOf(m.entrant1Id)} · ${nameOf(m.entrant2Id)}`
            .slice(0, NAME_MAX);

        const seats = rosterSizeFor(t.format) * 2;
        const created = await createLobby(ctx, userId, {
            title,
            modId: t.mod_id,
            modCombinedHash: hash,
            maxPlayers: seats,
            askedCompetitive: true,
            tournamentMatchId: mid,
            // Never: a round opening several rooms at once would fire a role-pinged Discord
            // embed and a global toast for each.
            announce: false,
        });
        invalidate(id);

        // The opponent has no reason to look. Everyone on the match except the person who
        // just opened it gets told; they can see the room on their own screen.
        const sides = [
            ...(await memberIdsOf(ctx, m.entrant1Id)),
            ...(await memberIdsOf(ctx, m.entrant2Id)),
        ].filter((u) => u !== userId);
        ctx.globalChat.announceTournamentUpdate({
            kind: 'room_opened',
            tournamentId: t.id,
            tournamentName: t.name,
            tournamentMatchId: mid,
            round: m.round,
            roundsTotal: rounds,
            lobbyId: created.id,
            perUser: new Map(sides.map((u) => [u, { youWon: null }])),
        });

        return reply.code(201).send({ ...created, host_user_id: userId, existing: false });
    });

    // ------------------------------------------------------------ owner actions

    app.patch('/tournaments/:id', {
        preHandler: [requireTournamentOwner(ctx), userRateLimit(ctx, Limits.TournamentWriteUser)],
    }, async (req) => {
        const id = paramId(req, 'id');
        const t = (await store.getTournament(ctx.db, id))!;
        if (t.status === 'running' || t.status === 'finished') {
            throw Errors.Conflict('The bracket has already been drawn.');
        }

        const body = (req.body ?? {}) as { name?: unknown; capacity?: unknown; entry_mode?: unknown };
        const fields: { name?: string; capacity?: number; entryMode?: 'open' | 'approval' } = {};

        if (body.name !== undefined) {
            const name = typeof body.name === 'string' ? body.name.trim().slice(0, NAME_MAX) : '';
            if (name.length < NAME_MIN) throw Errors.BadRequest('name too short');
            fields.name = name;
        }
        if (body.capacity !== undefined) {
            const capacity = clampCapacity(body.capacity);
            // Lowering below what is already confirmed would make confirmed_count > capacity
            // and every later claim fail for ever.
            if (capacity < t.confirmed_count) {
                throw Errors.Conflict('Capacity cannot be lower than the places already taken.');
            }
            fields.capacity = capacity;
        }
        if (body.entry_mode !== undefined) {
            fields.entryMode = readEnum(body.entry_mode, ['open', 'approval'] as const, 'entry_mode');
        }

        await store.updateTournamentSettings(ctx.db, id, fields);
        invalidate(id);
        return { ok: true, ...fields };
    });

    app.post('/tournaments/:id/open', {
        preHandler: [requireTournamentOwner(ctx), userRateLimit(ctx, Limits.TournamentWriteUser)],
    }, async (req) => {
        const id = paramId(req, 'id');
        const ok = await store.setTournamentStatus(
            ctx.db, id, 'registration', ['draft', 'ready'], 'registration_opened_at');
        if (!ok) throw Errors.Conflict('Registration cannot be opened from this state.');
        invalidate(id);
        return { ok: true, status: 'registration' };
    });

    app.post('/tournaments/:id/close', {
        preHandler: [requireTournamentOwner(ctx), userRateLimit(ctx, Limits.TournamentWriteUser)],
    }, async (req) => {
        const id = paramId(req, 'id');
        const ok = await store.setTournamentStatus(ctx.db, id, 'ready', ['registration']);
        if (!ok) throw Errors.Conflict('Registration is not open.');
        invalidate(id);
        return { ok: true, status: 'ready' };
    });

    app.post('/tournaments/:id/entrants/:eid/accept', {
        preHandler: [requireTournamentOwner(ctx), userRateLimit(ctx, Limits.TournamentWriteUser)],
    }, async (req) => {
        const id = paramId(req, 'id');
        const eid = paramId(req, 'eid');
        const e = await store.getEntrant(ctx.db, eid);
        if (!e || e.tournament_id !== id) throw Errors.NotFound('Entrant');

        // Accepting takes a seat. If there is none the entrant waits rather than being
        // refused — the owner already said yes, and turning that into a rejection would be
        // the server overruling them.
        const seat = await store.claimSeat(ctx.db, id);
        const next = seat ? 'confirmed' : 'waitlist';
        const ok = await store.setEntrantStatus(ctx.db, eid, next, ['pending', 'waitlist']);
        if (!ok) {
            if (seat) await store.releaseSeat(ctx.db, id);
            throw Errors.Conflict('That entrant is not awaiting a decision.');
        }
        invalidate(id);
        await notifyEntrant(ctx, id, eid, next === 'confirmed' ? 'entry_accepted' : 'entry_promoted');
        return { ok: true, status: next };
    });

    app.post('/tournaments/:id/entrants/:eid/reject', {
        preHandler: [requireTournamentOwner(ctx), userRateLimit(ctx, Limits.TournamentWriteUser)],
    }, async (req) => {
        const id = paramId(req, 'id');
        const eid = paramId(req, 'eid');
        const e = await store.getEntrant(ctx.db, eid);
        if (!e || e.tournament_id !== id) throw Errors.NotFound('Entrant');

        await withdraw(ctx, id, eid, e.status, 'rejected');
        invalidate(id);
        return { ok: true };
    });

    /**
     * Draft mode: fold several solo entrants into one team entrant.
     *
     * The third way a line-up comes to exist. Everybody signed up alone, and the owner now
     * decides who plays with whom — useful for a random-teams tournament, and the only mode
     * where the owner rather than a captain composes a side.
     *
     * Only before the bracket is drawn, and only in a team format that asked for it: after
     * `start` the sides are seated in matches and merging would rewrite history.
     */
    app.post('/tournaments/:id/entrants/merge', {
        preHandler: [requireTournamentOwner(ctx), userRateLimit(ctx, Limits.TournamentWriteUser)],
    }, async (req) => {
        const id = paramId(req, 'id');
        const t = (await store.getTournament(ctx.db, id))!;
        if (t.team_source !== 'draft') {
            throw Errors.BadRequest('this tournament does not assemble teams by hand');
        }
        if (t.status === 'running' || t.status === 'finished') {
            throw Errors.Conflict('The bracket has already been drawn.');
        }

        const body = (req.body ?? {}) as { entrant_ids?: unknown; display_name?: unknown };
        const ids = Array.isArray(body.entrant_ids)
            ? body.entrant_ids.filter((x): x is string => typeof x === 'string')
            : [];
        if (ids.length !== rosterSizeFor(t.format)) {
            throw Errors.BadRequest(`a ${t.format} side needs exactly ${rosterSizeFor(t.format)} entrants`);
        }

        const all = await store.listEntrants(ctx.db, id);
        const picked = ids.map((eid) => all.find((e) => e.id === eid));
        if (picked.some((e) => !e)) throw Errors.NotFound('Entrant');
        if (picked.some((e) => e!.kind !== 'solo')) {
            throw Errors.BadRequest('one of those is already a team');
        }
        if (new Set(ids).size !== ids.length) throw Errors.BadRequest('an entrant is listed twice');

        // Everyone who was in the merged entrants becomes the new roster. Reading it from
        // the frozen rows rather than from the captains means a solo entrant that was
        // itself assembled oddly still contributes exactly who it registered.
        const rosters = await store.loadRosters(ctx.db, id);
        const memberIds = ids.flatMap((eid) => rosters.get(eid) ?? []);
        if (memberIds.length !== rosterSizeFor(t.format)) {
            throw Errors.RosterInvalid('wrong_size');
        }

        // The merged side inherits a place only if the pieces held one. Counting how many
        // were confirmed and claiming exactly one seat back keeps `confirmed_count` honest:
        // three confirmed solos becoming one team frees two places for the waitlist.
        const confirmed = picked.filter((e) => e!.status === 'confirmed').length;
        const captain = picked[0]!.captain_user_id;
        const name = typeof body.display_name === 'string' && body.display_name.trim()
            ? body.display_name.trim().slice(0, NAME_MAX)
            : picked.map((e) => e!.display_name).join(' + ').slice(0, NAME_MAX);

        for (const e of picked) {
            await store.setEntrantStatus(ctx.db, e!.id, 'withdrawn',
                ['pending', 'confirmed', 'waitlist']);
        }
        for (let i = 0; i < confirmed; i++) await store.releaseSeat(ctx.db, id);

        const seat = confirmed > 0 ? await store.claimSeat(ctx.db, id) : false;
        const entrantId = uuid();
        await store.insertEntrant(ctx.db, {
            id: entrantId, tournamentId: id, kind: 'team', teamId: null,
            displayName: name, captainUserId: captain,
            status: seat ? 'confirmed' : 'waitlist',
        }, memberIds);
        invalidate(id);

        return { entrant_id: entrantId, status: seat ? 'confirmed' : 'waitlist', members: memberIds };
    });

    app.post('/tournaments/:id/seed', {
        preHandler: [requireTournamentOwner(ctx), userRateLimit(ctx, Limits.TournamentWriteUser)],
    }, async (req) => {
        const id = paramId(req, 'id');
        const t = (await store.getTournament(ctx.db, id))!;
        if (t.status !== 'ready') throw Errors.Conflict('Close registration before seeding.');

        const entrants = (await store.listEntrants(ctx.db, id)).filter((e) => playsInBracket(e.status));
        if (entrants.length < 2) throw Errors.Conflict('At least two entrants are needed.');

        const rosters = await store.loadRosters(ctx.db, id);
        const seedable = entrants.map((e) => ({
            entrantId: e.id,
            memberIds: rosters.get(e.id) ?? [],
            registeredAt: e.registered_at,
        }));

        const body = (req.body ?? {}) as { order?: unknown };
        let seeds;
        if (Array.isArray(body.order)) {
            const order = body.order.filter((x): x is string => typeof x === 'string');
            const r = seedByExplicitOrder(seedable, order);
            if (r.reason) throw Errors.BadRequest(`order is ${r.reason.replace('_', ' ')}`);
            seeds = r.seeds;
        } else {
            const mode = t.format === '1v1' ? 'default' : 'team';
            const ratings = await store.ratingsFor(ctx.db, [...rosters.values()].flat(), mode);
            seeds = seedByRating(seedable, ratings);
        }

        await store.setSeeds(ctx.db, id, seeds);
        invalidate(id);
        return { ok: true, seeds };
    });

    app.post('/tournaments/:id/start', {
        preHandler: [requireTournamentOwner(ctx), userRateLimit(ctx, Limits.TournamentWriteUser)],
    }, async (req) => {
        const id = paramId(req, 'id');
        const t = (await store.getTournament(ctx.db, id))!;
        if (t.status !== 'ready') throw Errors.Conflict('Close registration before starting.');

        const existing = await store.loadBracket(ctx.db, id);
        if (existing.length > 0) throw Errors.Conflict('The bracket has already been drawn.');

        const entrants = (await store.listEntrants(ctx.db, id)).filter((e) => playsInBracket(e.status));

        // generateBracket throws a bare Error on bad seeding, and the error handler turns
        // anything that is not an HttpError into a nameless 500. So everything it would
        // throw about is checked here first, where the client gets a reason.
        if (entrants.length < 2) throw Errors.Conflict('At least two entrants are needed.');
        const seeds = entrants.map((e) => e.seed);
        if (seeds.some((s) => s === null)) throw Errors.Conflict('Seed the entrants first.');
        const sorted = [...seeds as number[]].sort((a, b) => a - b);
        const contiguous = sorted.every((s, i) => s === i + 1);
        if (!contiguous) throw Errors.Conflict('Seeding is incomplete; seed the entrants again.');

        const matches = generateBracket(
            entrants.map((e) => ({ entrantId: e.id, seed: e.seed as number })), uuid);

        await store.insertBracket(ctx.db, id, matches);
        await store.setBracketSize(ctx.db, id, bracketSize(entrants.length));
        const ok = await store.setTournamentStatus(ctx.db, id, 'running', ['ready'], 'started_at');
        if (!ok) throw Errors.Conflict('The tournament is no longer ready to start.');
        invalidate(id);

        return { ok: true, rounds: roundsFor(entrants.length), matches: matches.length };
    });

    app.post('/tournaments/:id/matches/:mid/walkover', {
        preHandler: [requireTournamentOwner(ctx), userRateLimit(ctx, Limits.TournamentWriteUser)],
    }, async (req) => {
        const id = paramId(req, 'id');
        const mid = paramId(req, 'mid');
        const body = (req.body ?? {}) as { winner_entrant_id?: unknown };
        const winner = typeof body.winner_entrant_id === 'string' ? body.winner_entrant_id : '';
        if (!winner) throw Errors.BadRequest('winner_entrant_id required');

        const bracket = await store.loadBracket(ctx.db, id);
        const result = advance(bracket, mid, winner, 'walkover', await disqualifiedSet(ctx, id));
        if (!result.ok) throw Errors.Conflict(`Cannot award this match: ${result.reason}`);

        // Claim first, exactly as the report path does: two owners clicking at once, or a
        // resent request, must not advance the same winner twice.
        const claimed = await store.claimMatchResult(ctx.db, mid, winner, 'walkover', 'owner', null);
        if (!claimed) throw Errors.Conflict('That match has already been decided.');

        await store.applyMatchUpdates(ctx.db, result.updates.filter((u) => u.id !== mid));
        if (result.tournamentDone) {
            await store.finishTournament(ctx.db, id, result.championEntrantId);
        }
        invalidate(id);
        return { ok: true, tournament_done: result.tournamentDone };
    });

    app.post('/tournaments/:id/entrants/:eid/disqualify', {
        preHandler: [requireTournamentOwner(ctx), userRateLimit(ctx, Limits.TournamentWriteUser)],
    }, async (req) => {
        const id = paramId(req, 'id');
        const eid = paramId(req, 'eid');
        const e = await store.getEntrant(ctx.db, eid);
        if (!e || e.tournament_id !== id) throw Errors.NotFound('Entrant');

        await store.setEntrantStatus(ctx.db, eid, 'disqualified',
            ['pending', 'confirmed', 'waitlist']);

        // Every pending match of theirs whose opponent is already known becomes a walkover.
        // One where the opponent is still unknown stays pending on purpose: there is nobody
        // to award it to yet, and `advance` picks it up when somebody arrives.
        const bracket = await store.loadBracket(ctx.db, id);
        const updates = disqualify(bracket, eid);
        await store.applyMatchUpdates(ctx.db, updates);
        await store.touch(ctx.db, id);
        invalidate(id);
        return { ok: true, matches_awarded: updates.length };
    });

    app.post('/tournaments/:id/cancel', {
        preHandler: [requireTournamentOwner(ctx), userRateLimit(ctx, Limits.TournamentWriteUser)],
    }, async (req) => {
        const id = paramId(req, 'id');
        const ok = await store.setTournamentStatus(
            ctx.db, id, 'cancelled', ['draft', 'registration', 'ready', 'running'], 'cancelled_at');
        if (!ok) throw Errors.Conflict('This tournament is already over.');

        // Rooms bound to its matches have nothing left to play for. Closing the DB rows and
        // hanging up the sockets is the same pair every other close path does.
        for (const lobbyId of await store.openLobbiesForTournament(ctx.db, id)) {
            await ctx.db.batch([
                ctx.db.prepare(
                    `UPDATE lobbies SET status='closed', closed_at=datetime('now') WHERE id = ?`,
                ).bind(lobbyId),
                ctx.db.prepare(`DELETE FROM lobby_members WHERE lobby_id = ?`).bind(lobbyId),
            ]);
            ctx.rooms.close(lobbyId);
        }
        invalidate(id);
        return { ok: true, status: 'cancelled' };
    });
}

// ---------------------------------------------------------------- shared logic

function listView(t: store.TournamentListRow): Record<string, unknown> {
    return {
        id: t.id,
        name: t.name,
        mod_id: t.mod_id,
        owner_user_id: t.owner_user_id,
        format: t.format,
        team_source: t.team_source,
        entry_mode: t.entry_mode,
        status: t.status,
        capacity: t.capacity,
        confirmed_count: t.confirmed_count,
        entrant_count: t.entrant_count ?? 0,
        created_at: t.created_at,
        last_activity_at: t.last_activity_at,
    };
}

async function memberIdsOf(ctx: AppContext, entrantId: string): Promise<string[]> {
    const r = await ctx.db.prepare(
        `SELECT user_id FROM tournament_entrant_members WHERE entrant_id = ?`,
    ).bind(entrantId).all<{ user_id: string }>();
    return (r.results ?? []).map((x) => x.user_id);
}

/** Best-effort: an entrant who cannot be told is still accepted. */
async function notifyEntrant(
    ctx: AppContext,
    tournamentId: string,
    entrantId: string,
    kind: 'entry_accepted' | 'entry_promoted',
): Promise<void> {
    try {
        const t = await store.getTournament(ctx.db, tournamentId);
        if (!t) return;
        const members = await memberIdsOf(ctx, entrantId);
        ctx.globalChat.announceTournamentUpdate({
            kind,
            tournamentId: t.id,
            tournamentName: t.name,
            perUser: new Map(members.map((u) => [u, { youWon: null }])),
        });
    } catch { /* the entrant is accepted either way */ }
}

async function displayNameOf(ctx: AppContext, userId: string): Promise<string> {
    const u = await ctx.db.prepare(
        `SELECT display_name, discord_username FROM users WHERE id = ?`,
    ).bind(userId).first<{ display_name: string; discord_username: string }>();
    return u?.display_name || u?.discord_username || 'Unknown';
}

async function disqualifiedSet(ctx: AppContext, tournamentId: string): Promise<Set<string>> {
    const rows = await store.listEntrants(ctx.db, tournamentId);
    return new Set(rows.filter((e) => e.status === 'disqualified').map((e) => e.id));
}

/**
 * Take an entrant out and, if that frees a seat, promote whoever has waited longest.
 *
 * The seat is only released when the entrant actually held one — a waitlisted or pending
 * entrant never claimed anything, and releasing on their way out would invent a place the
 * tournament does not have.
 */
async function withdraw(
    ctx: AppContext,
    tournamentId: string,
    entrantId: string,
    currentStatus: string,
    next: 'withdrawn' | 'rejected' = 'withdrawn',
): Promise<void> {
    const moved = await store.setEntrantStatus(
        ctx.db, entrantId, next, ['pending', 'confirmed', 'waitlist']);
    if (!moved) return;
    if (currentStatus !== 'confirmed') return;

    await store.releaseSeat(ctx.db, tournamentId);

    const t = await store.getTournament(ctx.db, tournamentId);
    if (!t) return;
    const free = Math.max(0, t.capacity - t.confirmed_count);
    if (free <= 0) return;

    const candidates: WaitlistCandidate[] = (await store.listEntrants(ctx.db, tournamentId))
        .map((e) => ({ entrantId: e.id, status: e.status, registeredAt: e.registered_at }));

    for (const id of promoteFromWaitlist(candidates, free)) {
        // Claim per promotion rather than trusting the count read above: the seat may have
        // gone to a new registration between that read and this write.
        if (!(await store.claimSeat(ctx.db, tournamentId))) break;
        const ok = await store.setEntrantStatus(ctx.db, id, 'confirmed', ['waitlist']);
        if (!ok) await store.releaseSeat(ctx.db, tournamentId);
    }
}

async function buildDetail(ctx: AppContext, id: string): Promise<unknown> {
    const t = await store.getTournament(ctx.db, id);
    if (!t) throw Errors.NotFound('Tournament');

    const entrants = await store.listEntrants(ctx.db, id);
    const rosters = await store.loadRosters(ctx.db, id);
    const bracket = await store.loadBracket(ctx.db, id);

    const lobbies = new Map<string, { id: string; host_user_id: string; status: string }>();
    for (const m of bracket) {
        if (m.status !== 'pending') continue;
        const l = await store.activeLobbyForMatch(ctx.db, m.id);
        if (l) lobbies.set(m.id, { id: l.id, host_user_id: l.host_user_id, status: l.status });
    }

    return {
        id: t.id,
        name: t.name,
        mod_id: t.mod_id,
        owner_user_id: t.owner_user_id,
        format: t.format,
        team_source: t.team_source,
        entry_mode: t.entry_mode,
        status: t.status,
        capacity: t.capacity,
        confirmed_count: t.confirmed_count,
        bracket_size: t.bracket_size,
        rounds_total: t.bracket_size ? Math.log2(t.bracket_size) : null,
        winner_entrant_id: t.winner_entrant_id,
        created_at: t.created_at,
        entrants: entrants.map((e) => ({
            id: e.id,
            kind: e.kind,
            display_name: e.display_name,
            captain_user_id: e.captain_user_id,
            seed: e.seed,
            status: e.status,
            member_ids: rosters.get(e.id) ?? [],
        })),
        matches: bracket.map((m) => ({
            id: m.id,
            round: m.round,
            position: m.position,
            entrant1_id: m.entrant1Id,
            entrant2_id: m.entrant2Id,
            winner_entrant_id: m.winnerEntrantId,
            status: m.status,
            outcome: m.outcome,
            next_match_id: m.nextMatchId,
            next_slot: m.nextSlot,
            lobby: lobbies.get(m.id) ?? null,
        })),
    };
}
