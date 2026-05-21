# Doomsday Bot

Self-contained Telegram bot that extracts video URLs from streaming pages and pairs with the [Doomsday Player](https://github.com/Ibnuard/doomsday) for in-browser playback of hotlink-protected content.

## Quick deploy on a fresh VPS

One command, idempotent. Tested on Ubuntu 22.04 / 24.04 / Debian 12.

```bash
git clone https://github.com/Ibnuard/dd-bot.git ~/dd-bot
cd ~/dd-bot
sudo bash scripts/deploy.sh
```

The script handles, in order:

1. Install Docker + compose plugin (skipped if present).
2. Install Cloudflare WARP, register, and put it in proxy mode on `127.0.0.1:40000`. This is what bypasses datacenter-IP fingerprinting on Cloudflare-protected sites.
3. Install `socat` and a `warp-bridge.service` systemd unit that forwards `0.0.0.0:40001 → 127.0.0.1:40000`, so the docker container can reach WARP via `host.docker.internal:40001`.
4. Prompt for env vars and write `.env` (with `chmod 600`).
5. `docker compose up -d --build`.

Re-run the script any time — every step checks current state before acting.

## Architecture

```
[user paste URL]
       │
       ▼ Telegram polling
[bot extracts video URL via WARP-routed fetch]
       │
       ├─► reply: 📺 Watch  ─► doomsday-player on Vercel ─► /play (HLS-aware)
       └─► reply: 📥 Download ─► doomsday-player           ─► /api/stream?download=1
```

Inside the bot process:

| Module | Purpose |
|--------|---------|
| `index.js` | Entry — Telegram polling + reply formatter (inline keyboard with Watch/Download buttons) |
| `extractor.js` | Static HTML extraction with iframe-chain following + SOCKS proxy support |
| `sign.js` | HMAC signer that mints `/play` and `/api/stream?download=1` URLs paired with the player |

## Manual setup (without the script)

If you'd rather do it by hand, the script is annotated step-by-step. Otherwise:

```bash
# 1. Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER  # log out/in

# 2. Clone & .env
git clone https://github.com/Ibnuard/dd-bot.git ~/dd-bot
cd ~/dd-bot
cp .env.example .env
nano .env

# 3. Run
docker compose up -d
docker compose logs -f
```

WARP setup (only if your VPS gets blocked by Cloudflare on target sites) is documented inside `scripts/deploy.sh`.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | yes | From [@BotFather](https://t.me/BotFather) |
| `ALLOWED_CHAT_IDS` | no | Comma-separated Telegram chat IDs. Empty = open access. |
| `SCRAPERAPI_KEY` | no | Cloudflare-bypass fallback (5k req/mo free at scraperapi.com) |
| `PLAYER_BASE_URL` | recommended | Public URL of the deployed player, e.g. `https://doomsday-player.vercel.app`. Without this, the bot only replies with raw URLs (no Watch/Download buttons). |
| `STREAM_SECRET` | with player | Shared HMAC secret. Must match the player's `STREAM_SECRET` env var on Vercel. Generate with `openssl rand -hex 32`. |

Get your chat ID from [@userinfobot](https://t.me/userinfobot).

## Day-to-day commands

```bash
docker compose logs -f          # follow logs
docker compose restart          # restart container
docker compose down             # stop
docker compose ps               # status

# Update after a git pull
git pull
docker compose up -d --build
```

## Troubleshooting

| Symptom | Diagnosis |
|---------|-----------|
| `[bot] TELEGRAM_BOT_TOKEN not set` | `.env` missing, has CRLF line endings, or token field empty. Run `dos2unix .env` if you uploaded from Windows. |
| `[bot] polling error: ECONNREFUSED ...:40000` | `HTTPS_PROXY` / `HTTP_PROXY` is set in `.env` and Telegram polling is going through it. The bot uses `EXTRACTOR_PROXY` only for extractor traffic. Remove `HTTP(S)_PROXY` from `.env`. |
| `[extractor] direct hit Cloudflare challenge` | Target site is Cloudflare-protected. Set `SCRAPERAPI_KEY`, or run the deploy script so WARP is active. |
| Bot replies but Watch/Download buttons missing | `PLAYER_BASE_URL` or `STREAM_SECRET` not set. Check log for `[bot] player links: ENABLED`. |
| `address already in use` on `docker compose up` | Some other service holds port 3000 on the host. The bot itself does not need a port; `docker-compose.yml` already removes the mapping. |

## Security notes

- `.env` holds the bot token and HMAC secret. `.gitignore` excludes it.
- Set `ALLOWED_CHAT_IDS` if your bot is publicly findable.
- Player links expire after 24h by default (tunable in `sign.js`).
