/**
 * Mints a session for a LOCAL test account and prints it as JSON:
 *
 *   DEV_AUTH_BYPASS=true DB_PATH=... JWT_SIGNING_KEY=... tsx scripts/dev-token.ts <id> [display name]
 *
 * Used by the launcher's testbed (`testbed.py token`) to sign two or three accounts into a local
 * server without Discord. The dev sign-in route always yields ONE user, so it cannot do this.
 * Refuses unless DEV_AUTH_BYPASS=true (see devToken.ts). Run with the backend repo as the working
 * directory, so the migrations are found.
 */
import 'dotenv/config';
import { join } from 'node:path';
import { Db } from '../src/db';
import { loadConfig } from '../src/env';
import { mintSession } from '../src/lib/jwt';
import { devTokenRefusal, devUserRow } from './devToken';

async function main(): Promise<void> {
    const [id = '', name] = process.argv.slice(2);
    const cfg = loadConfig();
    const refusal = devTokenRefusal(cfg, id);
    if (refusal) {
        console.error(refusal);
        process.exit(2);
    }

    const db = new Db(cfg.dbPath);
    db.migrate(join(process.cwd(), 'migrations'));
    const row = devUserRow(id, name || `Test${id.toUpperCase()}`);
    await db.prepare(
        `INSERT INTO users (id, discord_id, discord_username, display_name, avatar_url)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT (discord_id) DO UPDATE SET
           discord_username = excluded.discord_username,
           display_name = excluded.display_name,
           last_seen_at = datetime('now')`,
    ).bind(row.id, row.discordId, row.username, row.displayName).run();

    const minted = await mintSession(row.id, row.username, cfg.jwtSigningKey);
    console.log(JSON.stringify({
        token: minted.token,
        expires_at: minted.expiresAt,
        // The shape the launcher keeps as multiplayer.cachedUser.
        user: { id: row.id, discord_username: row.username, display_name: row.displayName, avatar_url: null },
    }));
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
