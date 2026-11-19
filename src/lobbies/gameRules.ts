/**
 * A room's Game Rules (migration 0033): what the host's game opens its LAN lobby with.
 *
 * The values are the launcher's LanAutoStartArgs, which follow the game's own dropdown:
 * 0 Standard, 1 Classic, 2-5 Treaty 10/20/30/40 minutes, 6 Treaty - No Blockade,
 * 7 King of the Hill. Which of them a MOD offers (Wars of Liberty has no working treaties) is
 * the launcher's catalog data; the server only refuses what no room may carry.
 */

export const STANDARD_RULES = 0;
export const MAX_GAME_RULES = 7;

/**
 * The rules a new room gets, given what the client asked for. A request, not a decision, and
 * echoed back like `competitive`:
 *
 * - a COMPETITIVE room plays Standard, always: one ladder, one way to play it;
 * - a room BOUND to a tournament match or a quick-match proposal plays Standard, because nobody
 *   in it chose anything;
 * - anything that is not an integer 0-7 is Standard. `Number.isInteger` refuses NaN, Infinity,
 *   2.5 and the string "3" in one test.
 */
export function resolveGameRules(asked: unknown, room: { competitive: boolean; bound: boolean }): number {
    if (room.competitive || room.bound) return STANDARD_RULES;
    if (typeof asked !== 'number' || !Number.isInteger(asked)) return STANDARD_RULES;
    return asked >= 0 && asked <= MAX_GAME_RULES ? asked : STANDARD_RULES;
}

/**
 * The rules' name for the Discord embed. English on purpose: the embed is read by everybody on
 * the server, whatever language their launcher is in, like the room's title.
 */
export function gameRulesLabel(rules: number): string {
    switch (rules) {
        case 1: return 'Classic';
        case 2: return 'Treaty · 10 min';
        case 3: return 'Treaty · 20 min';
        case 4: return 'Treaty · 30 min';
        case 5: return 'Treaty · 40 min';
        case 6: return 'Treaty · No Blockade';
        case 7: return 'King of the Hill';
        default: return 'Standard';
    }
}
