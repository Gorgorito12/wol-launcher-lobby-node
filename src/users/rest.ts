/**
 * A player's own settings that OTHER players see. Today one: which rank badge shows beside
 * their name where no match decides it (design handoff 51c).
 *
 * <p>POST, not PATCH: the CORS setup allows GET/POST/PUT/DELETE only, and nothing here needs
 * PATCH's semantics.</p>
 */
import type { FastifyInstance } from 'fastify';
import { Errors } from '../lib/errors';
import { requireAuth } from '../middleware/auth';
import { userRateLimit, Limits } from '../middleware/rateLimit';
import type { AppContext } from '../context';
import { hasTeamPlace, parseBadgeMode } from './badgeMode';
import { parseSearchQuery, USER_SEARCH_SQL, userSearchParams } from './search';

export function registerUsersRest(app: FastifyInstance, ctx: AppContext): void {
    // Finding a player by name, for a team invitation or a line-up (see search.ts). An empty
    // answer for a fragment that is too short rather than a 400: the launcher asks as the
    // user types, and the first keystroke is not an error.
    app.get('/users/search', {
        preHandler: [requireAuth(), userRateLimit(ctx, Limits.UserSearchUser)],
    }, async (req) => {
        const q = parseSearchQuery((req.query as Record<string, unknown> | undefined)?.q);
        if (!q) return { users: [] };
        const rows = await ctx.db.prepare(USER_SEARCH_SQL)
            .bind(...userSearchParams(req.userId!, q))
            .all<{ user_id: string; display_name: string; avatar_url: string | null }>();
        return { users: rows.results ?? [] };
    });

    app.post('/me/badge-mode', {
        preHandler: [requireAuth(), userRateLimit(ctx, Limits.BadgeModeUser)],
    }, async (req, _reply) => {
        const body = (req.body ?? {}) as { badge_mode?: unknown };
        const mode = parseBadgeMode(body.badge_mode);
        if (!mode) throw Errors.BadRequest("badge_mode must be 'highest', '1v1' or 'team'.");

        // Teams needs a team rank to wear. Asked through the ladder's own WHERE so the unlock
        // and the badge can never disagree (see TEAM_BADGE_ELIGIBLE_SQL).
        if (mode === 'team' && !(await hasTeamPlace(ctx, req.userId!))) throw Errors.TeamBadgeLocked();

        await ctx.db.prepare('UPDATE users SET badge_mode = ? WHERE id = ?')
            .bind(mode, req.userId!).run();

        // The Players panel is the surface where everybody else sees it; refresh it now rather
        // than on the next presence change. Debounced inside, and it swallows its own errors.
        ctx.globalChat.refreshPlayers();

        return { badge_mode: mode };
    });
}
