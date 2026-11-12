/**
 * Who may see a rating that is still being PLACED.
 *
 * <p>A player's first {@link placementRequired} rated matches on a ladder place him
 * (src/elo/placement.ts). Until then his number swings by hundreds of points by design and says
 * little about how good he is — and showing it to OTHER players invited exactly the reading
 * placement exists to prevent: "he is 1380, easy game", or a room nobody joins because the host
 * reads 1720 after three lucky wins. So that number goes to its OWNER only. Everybody else gets
 * the progress ("in placement 3/10"), which is public, and the rating appears for everyone the
 * moment placement ends.</p>
 *
 * <p><b>Decided by the CURRENT state.</b> A player who finished placement shows his number
 * everywhere, his old placement matches included; a player still placing shows it nowhere but to
 * himself, old matches included. One rule, no per-match bookkeeping.</p>
 *
 * <p><b>Omit, never null, where a launcher reads a non-nullable number.</b> Every redactor here
 * DELETES the keys from a copy. Older launchers read some of these fields as plain doubles, and
 * a null there throws in System.Text.Json and takes the whole payload down, while a missing key
 * simply leaves the default. The one exception is presence, whose fields have always been typed
 * `number | null` and are nulled to keep that shape.</p>
 *
 * <p><b>Derived numbers leak it too.</b> A team's average minus his partner's rating, or a win
 * probability, gives the hidden rating straight back, so a room with anybody placing on its
 * ladder shows no odds at all ({@link anyPlacing}); the launcher hides the team average for the
 * same reason.</p>
 *
 * <p>Pure, and a LEAF: it imports only ./placement and types, so any module may use it without
 * reopening the stats/rest → matches/rest → badgeMode cycle that src/users/badgeMode.ts
 * documents. The launcher repeats this rule as a second layer (RatingDisplay.LookFor), so an
 * older server still shows nothing it should not.</p>
 */
import { isInPlacement, placementRequired } from './placement';
import type { RatingMode } from './glicko2';

/**
 * Whether a rating must be withheld from this viewer: he is not its owner, and its owner is still
 * being placed on that ladder. Unknown matches played (a lookup that failed) is NOT hidden — the
 * rating beside it is unknown too, and nothing about it is invented either way.
 */
export function ratingHiddenFrom(
    viewerId: string | null | undefined,
    ownerId: string,
    gamesPlayed: number | null | undefined,
    mode: RatingMode,
): boolean {
    if (viewerId != null && viewerId !== '' && viewerId === ownerId) return false;
    if (typeof gamesPlayed !== 'number' || !Number.isFinite(gamesPlayed)) return false;
    return isInPlacement(gamesPlayed, mode);
}

/** A copy of `obj` without `keys`. Never mutates: the caller's object is the room's live state. */
function without<T extends object>(obj: T, keys: readonly string[]): T {
    const copy = { ...obj } as Record<string, unknown>;
    for (const k of keys) delete copy[k];
    return copy as T;
}

// ---------------------------------------------------------------- room members (camelCase)

/** The rating fields a room member carries (LobbyRoom's MemberEntry). */
export interface RatedMember {
    rating?: number;
    rd?: number;
    ratingTeam?: number;
    rdTeam?: number;
    gamesPlayed?: number;
    gamesPlayedTeam?: number;
}

/** One member as `recipientId` may see him. Null recipient = anybody but the member himself. */
export function memberFor<T extends RatedMember>(ownerId: string, member: T, recipientId: string | null): T {
    const keys: string[] = [];
    if (ratingHiddenFrom(recipientId, ownerId, member.gamesPlayed, 'default')) keys.push('rating', 'rd');
    if (ratingHiddenFrom(recipientId, ownerId, member.gamesPlayedTeam, 'team')) keys.push('ratingTeam', 'rdTeam');
    return keys.length === 0 ? member : without(member, keys);
}

/** The whole roster of a `room_state`, as one recipient may see it. */
export function membersFor<T extends RatedMember>(
    members: Readonly<Record<string, T>>,
    recipientId: string,
): Record<string, T> {
    const out: Record<string, T> = {};
    for (const [id, m] of Object.entries(members)) out[id] = memberFor(id, m, recipientId);
    return out;
}

// ---------------------------------------------------------------- public payloads (snake_case)

/** The rating fields a public snake_case payload carries: a lobby's host, a `member_joined`. */
export interface PublicRatings {
    rating?: number | null;
    rd?: number | null;
    rating_team?: number | null;
    rd_team?: number | null;
    games_played?: number;
    games_played_team?: number;
}

/**
 * A payload anybody may receive — the rooms list (one cached body for every reader) and the
 * `member_joined` broadcast (which never reaches the member who joined) — without the ratings
 * of a ladder its owner is still being placed on.
 */
export function publicRatingsFor<T extends PublicRatings>(ownerId: string, payload: T): T {
    const keys: string[] = [];
    if (ratingHiddenFrom(null, ownerId, payload.games_played, 'default')) keys.push('rating', 'rd');
    if (ratingHiddenFrom(null, ownerId, payload.games_played_team, 'team')) keys.push('rating_team', 'rd_team');
    return keys.length === 0 ? payload : without(payload, keys);
}

// ---------------------------------------------------------------- presence (camelCase, nulled)

/** The rating fields of one presence entry, typed `number | null` since presence began. */
export interface PresenceRatings {
    userId: string;
    rating: number | null;
    rd: number | null;
    ratingTeam: number | null;
    rdTeam: number | null;
    gamesPlayed?: number;
    gamesPlayedTeam?: number;
}

/**
 * A presence entry for the players panel. Presence is ONE payload broadcast to everyone, so there
 * is no viewer: a placing player's number is null for all, himself included — his launcher takes
 * its own number from its own standing. Nulled rather than deleted, because these fields have
 * always been `number | null` and every launcher reads them as such.
 */
export function presenceFor<T extends PresenceRatings>(entry: T): T {
    const hideSolo = ratingHiddenFrom(null, entry.userId, entry.gamesPlayed, 'default');
    const hideTeam = ratingHiddenFrom(null, entry.userId, entry.gamesPlayedTeam, 'team');
    if (!hideSolo && !hideTeam) return entry;
    return {
        ...entry,
        ...(hideSolo ? { rating: null, rd: null } : {}),
        ...(hideTeam ? { ratingTeam: null, rdTeam: null } : {}),
    };
}

// ---------------------------------------------------------------- a player's standing

/** The fields of a ladder standing (src/stats/standing.ts) that carry the number itself. */
export interface StandingRatings {
    rating?: number;
    rd?: number;
    volatility?: number;
    games_played: number;
}

/**
 * One ladder of `GET /matches/elo/:id` as the requester may see it: the player himself always
 * gets everything; anybody else gets no rating, deviation or volatility while that ladder is
 * still placing him. Wins, losses, streaks and the progress stay — they are not the number.
 */
export function standingShownTo<T extends StandingRatings>(standing: T, mode: RatingMode, self: boolean): T {
    if (self || !isInPlacement(standing.games_played, mode)) return standing;
    return without(standing, ['rating', 'rd', 'volatility']);
}

// ---------------------------------------------------------------- match participants

/**
 * One participant row of a stored match (history, `recent_matches`, `GET /matches`). Only the id
 * is required: the rows are assembled from SQL, and what is withheld is `rating_before` and
 * `rating_after` whatever their type says.
 */
export interface StoredParticipant {
    user_id: string;
}

/** Matches played on each ladder RIGHT NOW, per user — the current state the rule reads. */
export type CurrentGames = ReadonlyMap<string, { default: number; team: number }>;

/**
 * A stored match's participants as `viewerId` may see them, plus each one's CURRENT placement on
 * the match's ladder (`in_placement`, `placement_played`, `placement_required`) so the launcher
 * can write "in placement 3/10" where it no longer has a number. A participant still being placed
 * loses his before/after for everybody else; once placed, his old matches show again.
 * Null viewer = a payload shared by everyone (the cached `recent_matches`).
 */
export function participantsFor<T extends StoredParticipant>(
    list: readonly T[],
    mode: RatingMode,
    viewerId: string | null,
    games: CurrentGames,
): Array<T & { in_placement?: boolean; placement_played?: number; placement_required: number }> {
    const required = placementRequired(mode);
    return list.map((p) => {
        const played = games.get(p.user_id)?.[mode];
        const placing = typeof played === 'number' && isInPlacement(played, mode);
        const shown = ratingHiddenFrom(viewerId, p.user_id, played, mode)
            ? without(p, ['rating_before', 'rating_after'])
            : p;
        return {
            ...shown,
            ...(typeof played === 'number'
                ? { in_placement: placing, placement_played: Math.min(played, required) }
                : {}),
            placement_required: required,
        };
    });
}

/**
 * The subject's OWN row in somebody's history (`GET /matches/history/:id`): it carries his
 * before/after at the top level, so it is withheld exactly like his participant entry when the
 * reader is somebody else and he is still being placed on that match's ladder.
 */
export function historyRowFor<T extends object>(
    row: T,
    subjectId: string,
    mode: RatingMode,
    viewerId: string | null,
    games: CurrentGames,
): T {
    const played = games.get(subjectId)?.[mode];
    return ratingHiddenFrom(viewerId, subjectId, played, mode)
        ? without(row, ['rating_before', 'rating_after'])
        : row;
}

/** One entry of a match RESULT payload (`match_reported`, the host's response). */
export interface ResultParticipant {
    user_id: string;
    placement_played?: number;
    placement_required?: number;
}

/**
 * A result payload's participants as `recipientId` may see them. The progress travels in each
 * entry (`ratingExtras`), and it is the progress AFTER this match: somebody this match placed is
 * shown with his number, somebody still placing is not. His result and his progress stay — the
 * card says "Pedro · in placement 4/10" where the rating would have been.
 */
export function resultParticipantsFor<T extends ResultParticipant>(list: readonly T[], recipientId: string | null): T[] {
    return list.map((p) => {
        if (recipientId != null && recipientId === p.user_id) return p;
        const played = p.placement_played;
        const required = p.placement_required;
        const placing = typeof played === 'number' && typeof required === 'number'
            && played > 0 && played < required;
        return placing ? without(p, ['rating_before', 'rating_after', 'rd_before', 'rd_after']) : p;
    });
}

// ---------------------------------------------------------------- odds

/** The flags a room member carries for {@link anyPlacing}. */
export interface PlacingFlags {
    inPlacement?: boolean;
    inPlacementTeam?: boolean;
}

/**
 * Whether anybody among these players is being placed on the room's ladder. The room's win
 * probability is then not shown at all: it is computed from the ratings, so it would hand the
 * hidden one straight back (two numbers and a percentage are enough to solve for the third).
 */
export function anyPlacing(players: readonly PlacingFlags[], mode: RatingMode): boolean {
    return players.some((p) => (mode === 'team' ? p.inPlacementTeam : p.inPlacement) === true);
}
