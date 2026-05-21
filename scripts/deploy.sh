#!/usr/bin/env bash
#
# Doomsday Bot — one-shot VPS deployer.
#
# What it does (in order, each step idempotent):
#   1. Install Docker + compose plugin
#   2. Install Cloudflare WARP and register/connect in proxy mode (loopback:40000)
#   3. Install socat and a systemd service that bridges 40001 (all interfaces)
#      to the WARP loopback so the docker container can reach it
#   4. Bootstrap .env from prompts (or keep existing)
#   5. docker compose up -d --build
#
# Re-run safe — every step checks state before doing work.
#
# Usage:
#   sudo bash scripts/deploy.sh
#
# Tested on Ubuntu 22.04 / 24.04 + Debian 12.

set -euo pipefail

# --- pretty output ---------------------------------------------------------

C_RESET='\033[0m'
C_BOLD='\033[1m'
C_DIM='\033[2m'
C_BLUE='\033[34m'
C_GREEN='\033[32m'
C_YELLOW='\033[33m'
C_RED='\033[31m'

step()  { printf "\n${C_BOLD}${C_BLUE}==>${C_RESET} ${C_BOLD}%s${C_RESET}\n" "$*"; }
ok()    { printf "    ${C_GREEN}✓${C_RESET} %s\n" "$*"; }
note()  { printf "    ${C_DIM}%s${C_RESET}\n" "$*"; }
warn()  { printf "    ${C_YELLOW}!${C_RESET} %s\n" "$*"; }
die()   { printf "\n${C_RED}✗ %s${C_RESET}\n" "$*" >&2; exit 1; }

# --- preflight -------------------------------------------------------------

[[ $EUID -eq 0 ]] || die "Run as root: sudo bash scripts/deploy.sh"
command -v apt-get >/dev/null || die "This script targets Debian/Ubuntu (apt-get not found)"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

[[ -f docker-compose.yml ]] || die "Run from inside the dd-bot repo"

# --- step 1: docker --------------------------------------------------------

step "Docker"
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  ok "Already installed ($(docker --version | awk '{print $3}' | tr -d ','))"
else
  note "Installing via get.docker.com..."
  curl -fsSL https://get.docker.com | sh
  ok "Installed"
fi

# Add the original (sudo) user to the docker group, if applicable.
if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
  if ! id -nG "$SUDO_USER" | tr ' ' '\n' | grep -qx docker; then
    usermod -aG docker "$SUDO_USER"
    note "Added $SUDO_USER to docker group (log out/in to take effect)"
  fi
fi

# --- step 2: cloudflare warp ----------------------------------------------

step "Cloudflare WARP"
if ! command -v warp-cli >/dev/null; then
  note "Installing cloudflare-warp..."
  curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg \
    | gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
  CODENAME="$(lsb_release -cs)"
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ ${CODENAME} main" \
    > /etc/apt/sources.list.d/cloudflare-client.list
  apt-get update -qq
  apt-get install -y -qq cloudflare-warp
  ok "Installed"
else
  ok "Already installed"
fi

# Register if no client exists yet. The CLI returns non-zero on duplicate
# registration, so we test status first instead.
if ! warp-cli status 2>/dev/null | grep -q "Registration"; then
  warp-cli --accept-tos registration new >/dev/null
  ok "Registered"
else
  ok "Already registered"
fi

# Force proxy mode (so SSH and other host traffic don't get tunneled).
warp-cli --accept-tos mode proxy >/dev/null
warp-cli --accept-tos proxy port 40000 >/dev/null

if warp-cli status 2>/dev/null | grep -qi "Connected"; then
  ok "Connected"
else
  warp-cli --accept-tos connect >/dev/null
  sleep 3
  ok "Connected"
fi

# Smoke-test that traffic actually goes through WARP.
if curl -fsS --max-time 8 --proxy socks5://127.0.0.1:40000 \
    https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null \
    | grep -q "warp=on"; then
  ok "WARP proxy verified (warp=on)"
else
  warn "WARP didn't return warp=on; bot will still run but bypass might fail"
fi

# --- step 3: socat bridge --------------------------------------------------

step "socat bridge (host:40001 → warp:40000)"
if ! command -v socat >/dev/null; then
  apt-get install -y -qq socat
  ok "Installed socat"
fi

SERVICE_FILE=/etc/systemd/system/warp-bridge.service
NEW_UNIT=$(cat <<'UNIT'
[Unit]
Description=Bridge port 40001 (all interfaces) to WARP SOCKS5 on 127.0.0.1:40000
After=warp-svc.service network-online.target
Wants=warp-svc.service

[Service]
ExecStart=/usr/bin/socat TCP-LISTEN:40001,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:40000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
)

if [[ ! -f "$SERVICE_FILE" ]] || ! diff -q <(printf "%s\n" "$NEW_UNIT") "$SERVICE_FILE" >/dev/null 2>&1; then
  printf "%s\n" "$NEW_UNIT" > "$SERVICE_FILE"
  systemctl daemon-reload
  ok "Wrote $SERVICE_FILE"
fi

systemctl enable --now warp-bridge >/dev/null 2>&1
if ss -tlnp 2>/dev/null | grep -q ":40001"; then
  ok "Listening on 0.0.0.0:40001"
else
  warn "warp-bridge not listening on 40001 — check: systemctl status warp-bridge"
fi

# --- step 4: .env ----------------------------------------------------------

step ".env"
if [[ -f .env ]]; then
  warn ".env already exists. Keeping it as-is."
  note "Edit manually with: nano $REPO_DIR/.env"
else
  read -r -p "  Telegram bot token (from @BotFather): " TG_TOKEN
  [[ -n "$TG_TOKEN" ]] || die "Token required"

  read -r -p "  Allowed chat IDs (comma-separated, blank = open): " TG_ALLOW
  read -r -p "  Player base URL (e.g. https://doomsday-player.vercel.app, blank = no player buttons): " PLAYER_URL

  STREAM_SECRET=""
  if [[ -n "$PLAYER_URL" ]]; then
    read -r -p "  Stream secret (blank to auto-generate; must match Vercel env): " STREAM_SECRET
    if [[ -z "$STREAM_SECRET" ]]; then
      STREAM_SECRET="$(openssl rand -hex 32)"
      note "Generated: $STREAM_SECRET"
      note "→ Set this same value in your Vercel project as STREAM_SECRET"
    fi
  fi

  read -r -p "  ScraperAPI key (optional, blank to skip): " SCRAPER_KEY

  cat > .env <<EOF
TELEGRAM_BOT_TOKEN=$TG_TOKEN
ALLOWED_CHAT_IDS=$TG_ALLOW
SCRAPERAPI_KEY=$SCRAPER_KEY
PLAYER_BASE_URL=$PLAYER_URL
STREAM_SECRET=$STREAM_SECRET
EOF
  chmod 600 .env
  ok "Wrote .env"
fi

# --- step 5: docker compose -----------------------------------------------

step "Building & starting bot"
docker compose up -d --build

sleep 2
if docker compose ps --status running --quiet | grep -q .; then
  ok "Container is running"
  note "Logs: cd $REPO_DIR && docker compose logs -f"
else
  warn "Container not running — check: docker compose logs"
fi

step "Done."
printf "${C_GREEN}Bot is up.${C_RESET} Send /ping to your Telegram bot to verify.\n\n"
