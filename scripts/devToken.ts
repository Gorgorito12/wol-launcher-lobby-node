/**
 * The pure half of `scripts/dev-token.ts`, which mints a session for a LOCAL test account so the
 * launcher's testbed can drive two or three accounts against one local server.
 *
 * It refuses outright unless the server is in dev mode (`DEV_AUTH_BYPASS=true`): a token minted
 * with a production signing key would be a real session for whoever is named, so the script has to
 * be useless against a deployed database. The id is restricted to a short slug so it can never
 * collide with a real Discord-backed user id (those are UUIDs) once prefixed.
 */

export const DEV_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

/** Why a token may not be minted, or null when it may. */
export function devTokenRefusal(cfg: { devAuthBypass: boolean }, id: string): string | null {
    if (!cfg.devAuthBypass) return 'DEV_AUTH_BYPASS is not true: refusing to mint a session.';
    if (!DEV_ID_PATTERN.test(id)) return `'${id}' is not a test id (lowercase letters, digits and '-', at most 32).`;
    return null;
}

/** The users row a test account gets: its own discord_id, so accounts never overwrite each other. */
export function devUserRow(id: string, name: string): { id: string; discordId: string; username: string; displayName: string } {
    return { id: `dev-${id}`, discordId: `dev:${id}`, username: id, displayName: name };
}
