# Doomsday Bot

Self-contained Telegram bot that extracts video URLs from streaming pages and serves an iOS-friendly player. **One Node.js process. No web framework. No build step.**

## Architecture

```
[Telegram user]                 [iOS Safari user]
       │                                │
       ▼                                ▼
  Telegram API                  https://your-vps/play
       │                                │
       └────────► doomsday-bot ◄────────┘
                  (this process)
                       │
                       ▼
            videccdn / vidvf / etc.
```

Inside the process:

| Module | Purpose |
|--------|---------|
| `index.js` | Entry point — boots HTTP server + Telegram poller |
| `extractor.js` | Static HTML extraction with iframe-chain following |
| `player.js` | `/play` page (HTML5 video) + `/stream` proxy (Range-aware) |

## Quick start (local)

### Option A: Docker (simplest)

```bash
cd DOOMSDAY_BOT
cp .env.example .env
# fill in TELEGRAM_BOT_TOKEN at minimum
docker compose up -d
```

### Option B: Plain Node

```bash
cd DOOMSDAY_BOT
npm install              # or pnpm install
cp .env.example .env
npm start
```

Either way:

- `curl http://localhost:3000/health` → "Doomsday Bot is running."
- DM your bot a video URL → get back direct + play links

## Deploy to a VPS (recommended: Docker)

```bash
# On VPS — install Docker once
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER  # log out/in after this

# Clone, configure, run
git clone <your-repo> /opt/doomsday
cd /opt/doomsday/DOOMSDAY_BOT
cp .env.example .env
nano .env   # fill TOKEN + PUBLIC_URL
docker compose up -d
docker compose logs -f       # check it boots cleanly
```

Update flow:

```bash
cd /opt/doomsday
git pull
docker compose up -d --build  # rebuilds image, recreates container
```

### Alternative: native Node + PM2 (no Docker)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs git
sudo npm install -g pnpm pm2

cd /opt
git clone <your-repo> doomsday
cd doomsday/DOOMSDAY_BOT
pnpm install
cp .env.example .env && nano .env
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

### Public HTTPS

Pick one (run on the host, not inside the container):

**Option 1: Caddy** (1-line auto-HTTPS, requires a domain pointed at the VPS)

```bash
sudo apt install -y caddy
echo 'doomsday.example.com {
  reverse_proxy localhost:3000
}' | sudo tee /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

**Option 2: Cloudflare Tunnel** (no domain, no port-forward)

```bash
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb
cloudflared tunnel login
cloudflared tunnel create doomsday
cloudflared tunnel route dns doomsday doomsday.example.com
sudo cloudflared service install <token-from-dashboard>
```

After HTTPS is live, set `PUBLIC_URL` in `.env` to the public URL and:

```bash
docker compose up -d   # picks up new env
# OR for native install:
pm2 reload doomsday-bot
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | yes | From [@BotFather](https://t.me/BotFather) |
| `PUBLIC_URL` | yes (for iOS links) | Public HTTPS URL of this server |
| `PORT` | no | HTTP port, default `3000` |
| `ALLOWED_CHAT_IDS` | no | Comma-separated Telegram chat IDs. Empty = open access. |
| `SCRAPERAPI_KEY` | no | Cloudflare-bypass fallback (5k req/mo free at scraperapi.com) |

Get your chat ID from [@userinfobot](https://t.me/userinfobot).

## Updating

```bash
cd /opt/doomsday
git pull
# Docker:
docker compose up -d --build
# Or native install:
cd DOOMSDAY_BOT && pnpm install && pm2 reload doomsday-bot
```

## Troubleshooting

| Symptom | Diagnosis |
|---------|-----------|
| Bot doesn't reply | `pm2 logs doomsday-bot` — check token + polling errors |
| 403 from videccdn / "Just a moment..." | Cloudflare flagging your VPS IP. Set `SCRAPERAPI_KEY` for residential-proxy fallback |
| `/play` link 404s on iOS | `PUBLIC_URL` mismatch. Must be reachable HTTPS from outside |
| Video plays only partially | Some hosts use signed URLs that expire after N minutes — re-extract |

## Security notes

- The `.env` file holds your bot token. Don't commit it (`.gitignore` already excludes it).
- Set `ALLOWED_CHAT_IDS` if your bot is publicly findable — otherwise anyone can use it.
- The `/stream` proxy passes through arbitrary URLs. If your VPS is small or bandwidth-limited, restrict who can use the bot.
