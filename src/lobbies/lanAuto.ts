/**
 * Whether a member's game enters the room's LAN game by itself (the launcher's LAN helper, or a
 * mod that ships things-new's lanAutoStart). Announced by each launcher about ITSELF with
 * `set_lan_auto`, relayed to the room as `member_lan_auto` and carried in `room_state` as
 * `lanAuto`, so the host can see who will have to enter by hand.
 *
 * Relayed, never interpreted: the server cannot check it and nothing is decided on it. A launcher
 * older than the frame never sends it, and the key stays absent — which the launcher shows as no
 * mark at all, never as "by hand".
 */

/** The flag a `set_lan_auto` frame carries, or null when it carries none a launcher would send. */
export function readLanAuto(frame: Readonly<Record<string, unknown>>): boolean | null {
    return typeof frame.auto === 'boolean' ? frame.auto : null;
}

/** Writes the flag on the member; true when it changed (and so is worth a broadcast). */
export function applyLanAuto(member: { lanAuto?: boolean } | undefined, auto: boolean): boolean {
    if (!member || member.lanAuto === auto) return false;
    member.lanAuto = auto;
    return true;
}
