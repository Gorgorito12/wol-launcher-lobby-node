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

## Updating (redeploy after a code change)

The service runs the TypeScript directly via `tsx` — there is **no build
step**. To ship a change that's already on GitHub:

```bash
cd /opt/wol-lobby
git pull
# Only if package.json changed (new/updated deps):
#   npm install --omit=dev
# Only if a new file landed under migrations/ (DB schema change):
#   npm run migrate
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
