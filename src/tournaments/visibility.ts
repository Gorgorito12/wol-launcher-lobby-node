/**
 * Changing a tournament's visibility after it was created (2026-11-18). The owner only (the route
 * runs `requireTournamentOwner`), and only before the bracket is drawn: entrants joined under one
 * expectation, and a bracket being played must not change who may see it. A leaf, pinned by
 * `visibility.test.ts`.
 */
export type Visibility = 'public' | 'private';

export type VisibilityDecision = 'locked' | 'unchanged' | 'change';

/** The states in which the visibility may still change. */
export const VISIBILITY_EDITABLE_STATES: readonly string[] = ['draft', 'registration', 'ready'];

export function decideVisibility(status: string, current: string | null | undefined, wanted: Visibility): VisibilityDecision {
    if (!VISIBILITY_EDITABLE_STATES.includes(status)) return 'locked';
    const now: Visibility = current === 'private' ? 'private' : 'public';
    return now === wanted ? 'unchanged' : 'change';
}

/** Whether a code can be renewed: only a private tournament has one. Any state: a leaked code
 *  opens a finished bracket too. */
export function mayRenewCode(visibility: string | null | undefined): boolean {
    return visibility === 'private';
}
