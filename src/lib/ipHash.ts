/**
 * One-way hashes of client IPs, for ONE rule: a very short match between a brand-new account and
 * an opponent on the same network does not rate (src/elo/newAccount.ts).
 *
 * <p><b>The raw address is never stored.</b> What is kept is an HMAC-SHA256 under a server secret,
 * truncated: enough to tell "these two connected from the same place" and nothing else — it
 * cannot be reversed or looked up, and it means nothing outside this server. Rows are pruned after
 * {@link IP_HASH_RETENTION_MS}.</p>
 *
 * <p><b>Which address.</b> `X-Real-IP`, which nginx sets to the peer it actually saw
 * (`$remote_addr`), and never the first entry of `X-Forwarded-For`: nginx APPENDS to that header,
 * so its first entry is whatever the client chose to send. Behind no proxy (local dev) the socket's
 * own address is used.</p>
 */
import { createHmac } from 'node:crypto';
import type { AppContext } from '../context';

export const IP_HASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface RequestLike {
    headers: Record<string, string | string[] | undefined>;
    socket?: { remoteAddress?: string | null } | null;
}

/** The client's address as this server can trust it, or null. */
export function requestIp(req: RequestLike): string | null {
    const real = req.headers['x-real-ip'];
    const v = Array.isArray(real) ? real[0] : real;
    if (typeof v === 'string' && v.trim()) return v.trim();
    const sock = req.socket?.remoteAddress;
    return typeof sock === 'string' && sock.trim() ? sock.trim() : null;
}

/**
 * The form two addresses are compared in: an IPv4-mapped IPv6 address becomes plain IPv4, and an
 * IPv6 address is cut to its /64 — the prefix a household is given, where the last 64 bits rotate
 * by design.
 */
export function canonicalIp(ip: string): string {
    let s = ip.trim().toLowerCase();
    if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7);
    if (!s.includes(':')) return s;
    const [head] = s.split('%');
    const parts = head!.split('::');
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
    const missing = Math.max(0, 8 - left.length - right.length);
    const groups = [...left, ...Array(missing).fill('0'), ...right]
        .map((g) => g.replace(/^0+(?=.)/, ''));
    return groups.slice(0, 4).join(':') + '::/64';
}

export function hashIp(ip: string, secret: string): string {
    return createHmac('sha256', secret).update(canonicalIp(ip)).digest('hex').slice(0, 32);
}

/** The secret: IP_HASH_SECRET, else one derived from the JWT signing key. Never empty. */
export function ipHashSecret(cfg: { ipHashSecret: string; jwtSigningKey: string }): string {
    if (cfg.ipHashSecret) return cfg.ipHashSecret;
    return createHmac('sha256', cfg.jwtSigningKey || 'wol-lobby').update('wol-ip-hash-v1').digest('hex');
}

/** Hash of a request's address, or null when there is none. */
export function requestIpHash(ctx: AppContext, req: RequestLike): string | null {
    const ip = requestIp(req);
    return ip ? hashIp(ip, ipHashSecret(ctx.config)) : null;
}

let lastPruneMs = 0;

/**
 * Remember that `userId` reached `lobbyId` from this hash. Best-effort and never throws: a failed
 * write only means the rule has less to go on, and it then answers "not shared". Prunes old rows
 * at most once an hour, inline — this server has no timers.
 */
export async function recordIpHash(
    ctx: AppContext,
    lobbyId: string,
    userId: string,
    hash: string | null,
): Promise<void> {
    if (!hash || !lobbyId || !userId) return;
    try {
        await ctx.db.prepare(
            `INSERT OR IGNORE INTO lobby_member_ips (lobby_id, user_id, ip_hash) VALUES (?, ?, ?)`,
        ).bind(lobbyId, userId, hash).run();
        const now = Date.now();
        if (now - lastPruneMs > 60 * 60 * 1000) {
            lastPruneMs = now;
            await ctx.db.prepare(
                `DELETE FROM lobby_member_ips WHERE seen_at < datetime('now', '-30 days')`,
            ).bind().run();
            await ctx.db.prepare(
                `UPDATE match_participants SET ip_hash = NULL
                  WHERE ip_hash IS NOT NULL
                    AND match_id IN (SELECT id FROM matches WHERE created_at < datetime('now', '-30 days'))`,
            ).bind().run();
        }
    } catch {
        // best-effort
    }
}
