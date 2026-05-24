import type { Config } from './env';
import type { Db } from './db';
import type { KvStore } from './kv';
import type { LobbyRoomRegistry } from './lobbies/LobbyRoom';

/**
 * Dependency container handed to every route and middleware. The Worker
 * version got this for free via Hono's <c>c.env</c>; in Node we just pass
 * the bag around explicitly. Centralises construction in <c>index.ts</c>
 * (one Db, one KvStore, one LobbyRoomRegistry, one Config) and makes the
 * shared lifecycle obvious — every dependency lives until <c>shutdown()</c>.
 */
export interface AppContext {
    config: Config;
    db: Db;
    kv: KvStore;
    rooms: LobbyRoomRegistry;
}
