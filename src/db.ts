import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Thin wrapper around better-sqlite3 that mimics the small slice of the
 * Cloudflare D1 API the original Worker used (`prepare(sql).bind(...)
 * .first() / .all() / .run()` and `batch([stmt, ...])`).
 *
 * Why a wrapper instead of using better-sqlite3 directly?
 *   * Keeps the Worker → Node port mechanical: every D1 call becomes the
 *     same call on this object. No "rewrite every query handler" pass.
 *   * Gives us a single place to add logging, query timing, or future
 *     migration to libsql if we want network-backed SQLite later.
 *
 * Concurrency model: better-sqlite3 is fully synchronous. Node's single
 * thread makes that fine — every handler awaits the result anyway, and
 * SQLite serialises writes internally via its journal file. WAL mode
 * (enabled below) lets readers run concurrently with the writer, which
 * is what we want for the lobby list polled by N clients while the
 * occasional INSERT happens in the background.
 */
export interface D1LikeResult<T> {
    results: T[];
}

export interface BoundStatement {
    first<T = unknown>(): Promise<T | undefined>;
    all<T = unknown>(): Promise<D1LikeResult<T>>;
    run(): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
}

export interface PreparedStatement {
    bind(...params: unknown[]): BoundStatement;
}

export class Db {
    private readonly inner: Database.Database;

    constructor(path: string) {
        this.inner = new Database(path);
        // WAL: better concurrency, smaller fsync cost. Foreign keys
        // mirror the PRAGMA already in the migration file but applying
        // it on every connection too is harmless and defensive.
        this.inner.pragma('journal_mode = WAL');
        this.inner.pragma('foreign_keys = ON');
        this.inner.pragma('synchronous = NORMAL');
    }

    /**
     * D1-style prepare. Returns an object whose <c>bind(...)</c> yields
     * the actual executable wrapper. Splitting it lets the same prepared
     * SQL be re-bound to different param sets if a handler wants to.
     */
    prepare(sql: string): PreparedStatement {
        const stmt = this.inner.prepare(sql);
        return {
            bind: (...params: unknown[]): BoundStatement => ({
                first: async <T = unknown>() => stmt.get(...params) as T | undefined,
                all: async <T = unknown>() => ({
                    results: stmt.all(...params) as T[],
                }),
                run: async () => {
                    const r = stmt.run(...params);
                    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
                },
            }),
        };
    }

    /**
     * D1-style batch. The original Worker used this for atomic
     * multi-statement writes. better-sqlite3 has <c>transaction()</c>
     * which gives us the same atomicity for free, so we wrap each
     * batch in one.
     */
    async batch(statements: BoundStatement[]): Promise<void> {
        // Each BoundStatement closes over its own .bind() params, so
        // executing them one-by-one inside a transaction gives the
        // batch semantics the Worker code expects.
        const tx = this.inner.transaction(() => {
            for (const s of statements) {
                // The Promise the wrapper returns is already resolved
                // synchronously by better-sqlite3 — invoking .run()
                // outside an `await` is safe and faster here because
                // we want everything to happen inside one tx scope.
                (s as unknown as { _exec?: () => void })._exec?.();
                // Fall-through: the wrapper above doesn't expose _exec;
                // calling .run() synchronously requires we evaluate the
                // already-resolved promise. better-sqlite3 is sync, so
                // the .then() callback runs in the same tick.
                void s.run();
            }
        });
        tx();
    }

    /**
     * Run every .sql file under <paramref name="migrationsDir"/> in
     * lexicographic order. Each file is wrapped in a transaction so a
     * mid-file failure rolls back cleanly. Track applied migrations in
     * a <c>_migrations</c> table so re-runs are no-ops.
     */
    migrate(migrationsDir: string): { applied: string[] } {
        this.inner.exec(`
            CREATE TABLE IF NOT EXISTS _migrations (
                filename TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
        `);

        const applied: string[] = [];
        const seen = new Set<string>(
            this.inner.prepare('SELECT filename FROM _migrations').all().map(
                (r) => (r as { filename: string }).filename,
            ),
        );

        const files = readdirSync(migrationsDir)
            .filter((f) => f.endsWith('.sql'))
            .sort();

        for (const f of files) {
            if (seen.has(f)) continue;
            const sql = readFileSync(join(migrationsDir, f), 'utf8');
            const apply = this.inner.transaction(() => {
                this.inner.exec(sql);
                this.inner.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(f);
            });
            apply();
            applied.push(f);
        }
        return { applied };
    }

    /** Raw access for the KV layer and ad-hoc queries. Use sparingly. */
    raw(): Database.Database { return this.inner; }

    close(): void { this.inner.close(); }
}
