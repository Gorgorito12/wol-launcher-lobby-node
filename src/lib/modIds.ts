/**
 * Mod-id lists the operator configures in the .env.
 *
 * <p>Two policies read lists of this shape: which mods score (`RANKED_MOD_IDS`, see
 * `isRankedMod`) and which mods' rooms each Discord webhook announces
 * (`DISCORD_WEBHOOK_MOD_IDS`). They share `modIdInList` because a second copy of that
 * rule is how `*` once came to mean "no mod at all" instead of "every mod".</p>
 *
 * <p>Ids compare trimmed and case-insensitively. A missing mod id never matches — not
 * even `*`, which means "every mod", not "anything at all".</p>
 */

/** The entry in a mod-id list that means "every mod". */
export const ALL_MODS = '*';

export function modIdInList(list: readonly string[], modId: string | null | undefined): boolean {
    const mod = (modId || '').trim().toLowerCase();
    if (mod.length === 0) return false;
    return list.some((m) => m === ALL_MODS || m === mod);
}

/**
 * Parse `DISCORD_WEBHOOK_MOD_IDS`: one slot per webhook, aligned POSITIONALLY with
 * `DISCORD_WEBHOOK_URL`, the same way `DISCORD_PLAYERS_ROLE_ID` is. A slot is one mod id
 * or several joined with `+` (`wol+improvement-mod`); an empty slot or `*` means every mod.
 *
 * <p>Slots are KEPT positionally — a blank in the middle is "every mod for that webhook",
 * not a slot to drop, or every webhook after it would read its neighbour's filter. Unset
 * or blank returns no slots at all, which `modsForWebhook` reads as every mod everywhere.</p>
 */
export function parseModSlots(raw: string | null | undefined): string[][] {
    if (!raw || raw.trim().length === 0) return [];
    return raw
        .split(/[,\n]/)
        .map((slot) => slot.trim().toLowerCase())
        .map((slot) => {
            const ids = slot.split(/[+|]/).map((s) => s.trim()).filter((s) => s.length > 0);
            return ids.length === 0 ? [ALL_MODS] : ids;
        });
}

/**
 * The mods the webhook at index `i` announces. A webhook with no slot of its own — one
 * appended to `DISCORD_WEBHOOK_URL` after the list was written — announces EVERY mod.
 * That is deliberate: the filter is a choice made for the webhooks that existed when it
 * was set, never a default a new channel inherits.
 */
export function modsForWebhook(slots: readonly (readonly string[])[], i: number): readonly string[] {
    return slots[i] ?? [ALL_MODS];
}
