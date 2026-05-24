import type { Db } from './db';

/**
 * Cloudflare KV replacement backed by a single SQLite table.
 *
 * Why not Redis or memcached?
 *   * One process, one VM. Adding another daemon doubles the things
 *     systemd has to babysit, and the KV traffic at our scale (a few
 *     hundred ops/min) doesn't justify a separate service.
 *   * SQLite gives us atomic TTL + persistence for free. A restart
 *     keeps OAuth device codes and join tokens valid — Redis would
 *     lose them unless we wired AOF, which is more pain than this.
 *
 * Schema (created on first <c>KvStore.init</c> call):
 *   kv (
 *     key        TEXT PRIMARY KEY,
 *     value      TEXT NOT NULL,
 *     expires_at INTEGER NULL   -- unix seconds; NULL = never expires
 *   )
 *
 * A periodic <c>sweepExpired()</c> tick removes stale rows. Reads also
 * check expiry inline so a value that timed out between the sweep and
 * the read is still treated as missing.
 */
export class KvStore {
    private readonly db: Db;
    private sweepTimer: NodeJS.Timeout | null = null;

    constructor(db: Db) {
        this.db = db;
    }

    init(): void {
        this.db.raw().exec(`
            CREATE TABLE IF NOT EXISTS kv (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                expires_at INTEGER NULL
            );
            CREATE INDEX IF NOT EXISTS idx_kv_expires ON kv (expires_at)
                WHERE expires_at IS NOT NULL;
        `);
    }

    /** Cloudflare KV's <c>.get(key)</c> — returns the stored string or null. */
    async get(key: string): Promise<string | null> {
        const row = this.db.raw().prepare(
            'SELECT value, expires_at FROM kv WHERE key = ?',
        ).get(key) as { value: string; expires_at: number | null } | undefined;

        if (!row) return null;
        if (row.expires_at != null && row.expires_at < Math.floor(Date.now() / 1000)) {
            // Lazy purge — saves the periodic sweep from being the only
            // thing keeping the table tidy.
            this.db.raw().prepare('DELETE FROM kv WHERE key = ?').run(key);
            return null;
        }
        return row.value;
    }

    /**
     * Cloudflare KV's <c>.put(key, value, { expirationTtl })</c>.
     * <paramref name="expirationTtlSec"/> follows the Workers convention:
     * seconds from now. Omit (undefined) to store without expiry.
     */
    async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
        const expiresAt = opts?.expirationTtl
            ? Math.floor(Date.now() / 1000) + opts.expirationTtl
            : null;
        this.db.raw().prepare(
            `INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?)
             ON CONFLICT (key) DO UPDATE SET
               value = excluded.value,
               expires_at = excluded.expires_at`,
        ).run(key, value, expiresAt);
    }

    async delete(key: string): Promise<void> {
        this.db.raw().prepare('DELETE FROM kv WHERE key = ?').run(key);
    }

    /**
     * Drop every row whose expiry already passed. Called on a 60 s
     * timer; cheap because the index restricts the scan to non-null
     * expires_at and the daily-counter rows we touch most aren't
     * tagged with one.
     */
    sweepExpired(): { removed: number } {
        const now = Math.floor(Date.now() / 1000);
        const r = this.db.raw().prepare(
            'DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at < ?',
        ).run(now);
        return { removed: r.changes };
    }

    startSweepLoop(): void {
        if (this.sweepTimer) return;
        // 60 s is fine: nothing we put here cares about sub-minute
        // precision (rate-limit windows are minute-sized, OAuth device
        // codes live ~15 min, join tokens 2 min). The lazy-purge in
        // get() catches anything in between.
        this.sweepTimer = setInterval(() => this.sweepExpired(), 60_000);
        // Don't keep the process alive just for the sweeper.
        this.sweepTimer.unref?.();
    }

    stopSweepLoop(): void {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
    }
}
