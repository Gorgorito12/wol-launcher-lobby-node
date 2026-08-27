# wol-launcher-lobby-node — deployment

Self-hosted Node.js + Fastify backend for the AoE3 Mod Launcher
multiplayer lobby. Replaces the original Cloudflare Worker
(`wol-launcher-lobby-worker`) with a single VM you control.

## Pre-flight: DuckDNS subdomain

The backend needs HTTPS for Discord OAuth callbacks to work cleanly,
and HTTPS needs a domain. DuckDNS gives you one for free:

1. Visit <https://www.duckdns.org> → sign in with GitHub.
2. In the "domains" box, type the subdomain you want
   (e.g. `wol-lobby`) and click **add domain**.
3. In the "current ip" field, type your Oracle VM's public IPv4
   (`129.213.62.16` in our case) and click **update ip**.
4. Note the **token** at the top of the page — needed for renewals.

Verify resolution:

```bash
dig +short wol-lobby.duckdns.org
# should print 129.213.62.16
```

## On the Oracle VM

```bash
# 1. Install Node 20 + nginx + certbot
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx \
    build-essential   # needed to compile better-sqlite3

# 2. Create the service user + data dir
sudo useradd --system --home /var/lib/wol-lobby --shell /usr/sbin/nologin wol-lobby
sudo mkdir -p /var/lib/wol-lobby/replays
sudo chown -R wol-lobby:wol-lobby /var/lib/wol-lobby

# 3. Drop the repo at /opt/wol-lobby (clone or scp)
sudo mkdir -p /opt/wol-lobby
sudo chown $USER /opt/wol-lobby
# … copy or git clone this folder into /opt/wol-lobby …
cd /opt/wol-lobby
npm install --omit=dev          # better-sqlite3 will compile here

# 4. Configure env
cp .env.example .env
# Edit .env. The values that matter:
#   - HOST=127.0.0.1                          (Fastify listens local; nginx proxies in)
#   - PORT=8080
#   - DB_PATH=/var/lib/wol-lobby/lobby.db
#   - REPLAYS_DIR=/var/lib/wol-lobby/replays
#   - PUBLIC_BASE_URL=https://wol-lobby.duckdns.org
#                                              (Match the Redirect URI registered in Discord exactly.)
#   - JWT_SIGNING_KEY=$(openssl rand -hex 32)
#   - DISCORD_CLIENT_ID=...                   (from discord.com/developers/applications)
#   - DISCORD_CLIENT_SECRET=...
#   - (optional) GLOBAL_CHAT_MSGS_PER_MIN / GLOBAL_CHAT_HISTORY /
#     GLOBAL_CHAT_MAX_CONNECTIONS — global-chat limits; omit to use the
#     defaults (20 msgs/min · 100 history · 60 connections). See .env.example.
sudo chown wol-lobby:wol-lobby .env
sudo chmod 600 .env

# 5. Install the systemd unit
sudo cp systemd/wol-lobby.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now wol-lobby
sudo systemctl status wol-lobby --no-pager   # should be active (running)
journalctl -u wol-lobby -n 50 --no-pager     # check startup logs

# 6. Smoke-test from the VM itself (no nginx yet)
curl http://127.0.0.1:8080/health
# → {"ok":true,"version":"0.1.0", ... }
```

## nginx + Let's Encrypt

```bash
# 1. WebSocket upgrade map (only needed if not already present)
echo 'map $http_upgrade $connection_upgrade {
    default upgrade;
    ""      close;
}' | sudo tee /etc/nginx/conf.d/upgrade-map.conf

# 2. Place the site config
sudo cp nginx/wol-lobby.conf /etc/nginx/sites-available/wol-lobby.conf
sudo sed -i 's/CHANGE-ME.duckdns.org/wol-lobby.duckdns.org/g' \
    /etc/nginx/sites-available/wol-lobby.conf
sudo ln -s /etc/nginx/sites-available/wol-lobby.conf \
    /etc/nginx/sites-enabled/wol-lobby.conf
sudo nginx -t && sudo systemctl reload nginx

# 3. Mint the cert (port 80 must be reachable from the internet)
sudo certbot --nginx -d wol-lobby.duckdns.org
# → answer the email prompt, accept the T&C, agree to redirect
# certbot rewrites the nginx config in-place with the cert paths
# and adds a renewal cron under /etc/cron.d/.

# 4. Verify HTTPS from outside the VM
curl https://wol-lobby.duckdns.org/health
```

## Oracle Cloud Security List

Make sure UDP/TCP for the public endpoints are open:

| Port  | Proto | Why |
|-------|-------|-----|
| 80    | TCP   | Let's Encrypt HTTP-01 challenge + redirect |
| 443   | TCP   | HTTPS (REST + WebSocket) |
| 7777  | UDP   | (unrelated; only needed if you also run n2n supernode) |

Add inbound rules in: Console → Networking → VCN → Security Lists →
Default → Add Ingress Rules.

## Point the launcher at the new backend

Edit the default in `Models/LauncherConfig.cs`:

```csharp
public string LobbyBaseUrl { get; set; } = "https://wol-lobby.duckdns.org";
```

Republish (`build-release.ps1`) — every fresh launcher install hits
the new backend. Existing users with the old default still point at
the Cloudflare Worker until they update OR the `MigrateLobbyBaseUrl`
heuristic catches the old URL (you can extend that list to include
the old Worker URL so it auto-rewrites to the new one on next launch).

## Before you deploy: check it parses

The service runs TypeScript directly through `tsx`, with no build step — which means
**nothing checks the code until the process starts**, and a syntax error there does
not produce an application error. The module fails to load, the process exits before
it can listen, and nginx answers **502 to every request with nothing in the app log,
because the app never ran.** That has happened once, from a single stray newline
inside a regex literal in `env.ts`.

```bash
node scripts/syntax-check.mjs src
```

It needs no dependencies. On a Windows machine with no Node installed, VS Code's
Electron is one:

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" scripts/syntax-check.mjs src
```

`lib/errors.ts` always reports one failure — a constructor parameter property, which
Node's strip-only mode refuses by design. Ignore that one; anything else is real.

With the dependencies installed, `npm run typecheck` and `npm test` are stricter and
should be preferred. The check above is the one that works when they are not.

## Updating (redeploy after a code change)

The service runs the TypeScript directly via `tsx` — there is **no build
step**. To ship a change that's already on GitHub:

```bash
cd /opt/wol-lobby
git pull
# Only if package.json changed (new/updated deps):
#   npm install --omit=dev
# Migrations need NO step of their own: src/index.ts runs db.migrate() on every
# start, inside a transaction, and records each file in the _migrations table so
# a re-run is a no-op. The restart below applies anything new under migrations/.
sudo systemctl restart wol-lobby
sudo systemctl status wol-lobby --no-pager   # → active (running)
curl http://127.0.0.1:8080/health            # → {"ok":true, ...}
```

Most launcher-feature backends are **code-only** changes: no new deps, no
migration, no nginx edit — `git pull` + `systemctl restart` is the whole
deploy. Example: the recent multiplayer features — **host migration**,
the **abort-grace window**, **kick** (`handleKick`) and the per-player ping
plumbing (`set_radmin_ip` → `member_net`) — all live in
`src/lobbies/LobbyRoom.ts` + `src/lobbies/rest.ts` over the existing
`/lobbies/:id/ws` route, so they shipped with nothing but a pull + restart
(deploy them **together with the matching launcher** — the new WS frames are
ignored by old clients). Another example: the **global chat** is a WebSocket
room at `/global/ws`
held in memory (`src/global/GlobalChatRoom.ts`); it rides the existing
nginx `location /` upgrade block, so nginx is untouched, and its limits
are env knobs (`GLOBAL_CHAT_*`, all optional with defaults). To confirm a
WS route is live after a restart:

```bash
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  http://127.0.0.1:8080/global/ws
# → HTTP/1.1 101 Switching Protocols   (404 = route not deployed)
```

## Resetting the ratings

Only ever needed on purpose — this throws every player's ELO away. It exists
because the ratings built before the ratability rule landed were mostly made of
matches nobody won: `POST /matches` used to feed EVERY report to Glicko, and
since AoE3 does not record by default almost every stored match has no winner.

The match history is NOT touched: `matches` and `match_participants.result` stay
whole. Only `elo_ratings` and the per-participant `rating_before`/`rating_after`
go.

```bash
sudo systemctl stop wol-lobby

# Back up all THREE files, not just the .db. The database runs in WAL mode, so the
# -wal sidecar can hold committed transactions the .db does not yet contain, and
# copying the .db alone can capture a state that never existed. With the service
# stopped nothing is writing, so copying the set together is consistent — and
# unlike `sqlite3 .backup` it needs no extra package installed. (sqlite3 is NOT
# part of this install: the service reaches SQLite through better-sqlite3 and
# never shells out to it.)
BK=/var/lib/wol-lobby/backup-$(date +%F)
sudo mkdir -p "$BK"
sudo cp -a /var/lib/wol-lobby/lobby.db* "$BK"/
sudo ls -l "$BK"          # confirm there is something there before continuing

# As the SERVICE's user, and with the tsx that is already installed — not npx.
# Running it as your own login user fails twice over: it cannot read the service's
# .env, and it cannot write the database.
cd /opt/wol-lobby
sudo -u wol-lobby ./node_modules/.bin/tsx scripts/reset-elo.ts

sudo systemctl start wol-lobby
```

The script needs no secrets — only the database path, which it takes from `DB_PATH`
(the environment, or the service's `.env`), or from an explicit first argument:
`sudo -u wol-lobby ./node_modules/.bin/tsx scripts/reset-elo.ts /var/lib/wol-lobby/lobby.db`

To roll back, copy the files out of that backup directory and start the service. This is
deliberately a script and not a migration: a migration is remembered in the
`_migrations` table of the database it ran against, so restoring the backup and
starting up would re-run it and delete the ratings you had just restored.

## Reading the match confirmations

> These queries need the `sqlite3` CLI, which is **not** installed by default —
> nothing in the service uses it. `sudo apt install -y sqlite3` once, if you want
> them.


Only the host reports a result; the other player's launcher reads its own recording
and sends that too, as **evidence only** — it gates nothing. The point of collecting
it is to answer, with real numbers rather than a guess, whether requiring the two to
agree would ever be viable.

```bash
sqlite3 /var/lib/wol-lobby/lobby.db "
  SELECT CASE
           WHEN c.user_id IS NULL          THEN 'no confirmation'
           WHEN c.result = 0.5             THEN 'guest could not read it'
           WHEN p.result = 0.5             THEN 'host could not read it'
           WHEN (c.result >= 0.999) = (p.result >= 0.999) THEN 'agree'
           ELSE 'DISAGREE'
         END AS verdict,
         COUNT(*)
  FROM matches m
  JOIN match_participants p ON p.match_id = m.id AND p.user_id <> m.host_user_id
  LEFT JOIN match_confirmations c
         ON c.match_id = m.id AND c.user_id = p.user_id
  GROUP BY verdict;"
```

**"no confirmation" is the number that decides it.** If most matches have one, the
readings can be required to agree; if most do not — the guest closed the launcher,
or their game was not recording — requiring agreement would stop counting the very
matches it was meant to protect.

A `DISAGREE` is worth looking at one by one. Two honest recordings of the same match
cannot contradict each other: the trailer names winner and loser by absolute slot.

**Were they even reading the same match?** That is what the game fingerprint answers,
and it is also the query that settles whether the host clock can be trusted across
machines — the seed must be shared (both sides generate the same map from it), the
clock is only assumed to be:

```bash
sqlite3 /var/lib/wol-lobby/lobby.db "
  SELECT CASE
           WHEN m.game_seed IS NULL OR c.game_seed IS NULL THEN 'no fingerprint'
           WHEN m.game_seed <> c.game_seed                 THEN 'DIFFERENT GAME'
           WHEN m.game_host_time = c.game_host_time        THEN 'same game, clock matches'
           ELSE 'same game, clock differs'
         END AS verdict,
         COUNT(*)
  FROM match_confirmations c
  JOIN matches m ON m.id = c.match_id
  GROUP BY verdict;"
```

If **`same game, clock differs`** never appears, `game_host_time` is common to both
sides and may be promoted into the comparison in `tieConfirmations` — it is recorded
but deliberately excluded from the verdict until then. If **`DIFFERENT GAME`**
appears, somebody's launcher picked the wrong recording, which is the whole reason
this fingerprint exists.

The same lines are in the service log as they happen:

```bash
journalctl -u wol-lobby | grep 'match confirmation compared'
```

## Backups

The whole world fits in one folder:

```bash
sudo tar -czf wol-lobby-backup-$(date +%F).tar.gz \
    /var/lib/wol-lobby /opt/wol-lobby/.env
```

A nightly cron + scp to S3/B2/Drive is enough.

## Operating

```bash
sudo systemctl restart wol-lobby                 # restart the backend
journalctl -u wol-lobby -f                       # tail logs
sqlite3 /var/lib/wol-lobby/lobby.db 'SELECT COUNT(*) FROM users'
                                                  # peek into the data
```

## Matches decided by a late reading

Since the correction path landed, a match stored with no result can be decided
afterwards by **either** player's own reading of their own recording — the host's, if
they found theirs seconds after reporting, or the other player's. Reporting is still
host-only; this only corrects a row that already exists.

Who is allowed to decide what is the rule in `src/elo/ratability.ts`
(`canUpgradeFromConfirmation`), and its one anti-abuse clause is worth knowing when
reading these numbers: **you may concede your own defeat freely, and claim your own
victory only when the fingerprint the reporter already stored matches yours.** The
server never reads the recording — `result` is a number the client sends — so the rule
does not verify the claim, it removes the reason to invent one: a liar can only give
points away.

```bash
# Matches decided after the fact, newest first.
sqlite3 /var/lib/wol-lobby/lobby.db \
  "SELECT id, mod_id, decided_by, created_at FROM matches
   WHERE decided_by IS NOT NULL ORDER BY created_at DESC LIMIT 20"

# Still waiting: stored undecided, nobody has managed to decide them.
sqlite3 /var/lib/wol-lobby/lobby.db \
  "SELECT COUNT(*) FROM matches WHERE unrated_reason = 'no_decided_result'"
```

```
journalctl -u wol-lobby | grep 'match decided by a late reading'
journalctl -u wol-lobby | grep 'late reading refused'      # and WHY, per attempt
```

### The number that decides whether agreement can be REQUIRED

`match_confirmations.agreement` is now **stored**, not only logged — the log rotates and
is gone, and this is the statistic migration 0004 created the table to collect. Three
questions, three queries:

```bash
# 1. When both readings arrive, do they agree?
sqlite3 /var/lib/wol-lobby/lobby.db \
  "SELECT agreement, COUNT(*) FROM match_confirmations
   WHERE agreement IS NOT NULL GROUP BY agreement"

# 2. Were they even reading the same game?
sqlite3 /var/lib/wol-lobby/lobby.db \
  "SELECT same_game, COUNT(*) FROM match_confirmations
   WHERE same_game IS NOT NULL GROUP BY same_game"

# 3. THE one that actually decides it: how often does the second reading never arrive?
#    No column needed — it is the absence of a row.
sqlite3 /var/lib/wol-lobby/lobby.db \
  "SELECT COUNT(*) AS matches_with_no_confirmation FROM matches m
   WHERE m.lobby_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM match_confirmations c WHERE c.match_id = m.id)"
```

If (3) is large, requiring both players to agree would leave most real matches unrated —
which is what the evidence suggested at the time this was written, and why the rule
accepts a single reading rather than demanding two.

### Antes de reiniciar: dos cosas que muerden

**1. La migración `0006` es todo-o-nada.** `Db.migrate` ejecuta el archivo entero dentro de
una transacción, así que si UNA de sus cinco `ALTER TABLE` falla — por ejemplo porque alguien
agregó `rated` a mano durante un diagnóstico — el archivo completo se revierte, `migrate()`
lanza, y **el servicio no arranca**. Comprobalo antes:

```bash
sqlite3 /var/lib/wol-lobby/lobby.db 'PRAGMA table_info(matches)' | grep -E 'unrated_reason|rated|decided_by'
sqlite3 /var/lib/wol-lobby/lobby.db 'PRAGMA table_info(match_confirmations)' | grep -E 'agreement|same_game'
```

Si no devuelven nada, `0006` va a aplicar limpio. Si devuelven algo, editá la migración para
sacar esa columna antes de desplegar.

**2. `npm ci` compila `better-sqlite3` desde el código fuente si tu Node no tiene binario
precompilado.** Con Node 24 no lo hay para la versión fijada (`^11.3.0`) y `npm ci` falla
entero en esa dependencia — medido. Node 20 y 22 sí tienen. Verificá `node --version` en el
server antes de tocar nada; si algún día actualizás Node ahí, esto es lo que se va a romper.

### Settling the backlog

Matches played BEFORE this landed can still be decided from the confirmations already in
the database. Dry run first — it changes history rows that people have already seen:

```bash
cd /opt/wol-lobby
npx tsx scripts/upgrade-pending.ts            # lists what it would decide, writes nothing
npx tsx scripts/upgrade-pending.ts --apply    # writes
```
