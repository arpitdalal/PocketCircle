#!/usr/bin/env bash
set -Eeuo pipefail

# Start the local web app, local MCP Worker, and named Cloudflare Tunnel used
# for ChatGPT developer-mode testing. Convex remains the configured cloud dev
# deployment from .env.local / packages/convex/.env.local.

cd "$(dirname "$0")/.."

TUNNEL_HOST="${POCKETCIRCLE_MCP_TUNNEL_HOST:-mcp-dev.pocketcircle.app}"
TUNNEL_NAME="${POCKETCIRCLE_MCP_TUNNEL_NAME:-pocketcircle-dev}"
CLOUDFLARED_DIR="${CLOUDFLARED_DIR:-${HOME}/.cloudflared}"
TUNNEL_CONFIG="${POCKETCIRCLE_MCP_TUNNEL_CONFIG:-${CLOUDFLARED_DIR}/${TUNNEL_NAME}.yml}"
LOCAL_WEB_URL="http://127.0.0.1:5173"
LOCAL_MCP_URL="http://127.0.0.1:8788"
PUBLIC_MCP_URL="https://${TUNNEL_HOST}"

PIDS=()

log() {
  printf '\033[1;34m▶ %s\033[0m\n' "$*"
}

fail() {
  printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2
  exit 1
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if ((${#PIDS[@]} > 0)); then
    for pid in "${PIDS[@]}"; do
      kill "$pid" >/dev/null 2>&1 || true
    done
    for pid in "${PIDS[@]}"; do
      wait "$pid" >/dev/null 2>&1 || true
    done
  fi
  if [[ "$status" == "0" ]]; then
    log "Stopped local ChatGPT test stack"
  fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT TERM

command -v pnpm >/dev/null 2>&1 || fail "pnpm is required"
command -v cloudflared >/dev/null 2>&1 || fail "cloudflared is required; install it with: brew install cloudflared"
command -v curl >/dev/null 2>&1 || fail "curl is required"

[[ -f .env.local ]] || fail "Missing .env.local. Copy .env.example and configure the Convex dev deployment first."
[[ -f packages/mcp-worker/.dev.vars ]] || fail "Missing packages/mcp-worker/.dev.vars. Copy .dev.vars.example and use the Convex dev Worker credentials."
[[ -f "$TUNNEL_CONFIG" ]] || fail "Missing $TUNNEL_CONFIG. Create the named Cloudflare Tunnel config first."
grep -q '^VITE_CONVEX_URL=' .env.local || fail ".env.local is missing VITE_CONVEX_URL"
grep -q '^VITE_CONVEX_SITE_URL=' .env.local || fail ".env.local is missing VITE_CONVEX_SITE_URL"
grep -q '^MCP_WORKER_HMAC_SECRET=' packages/mcp-worker/.dev.vars || fail ".dev.vars is missing MCP_WORKER_HMAC_SECRET"
grep -q '^MCP_WORKER_SIGNING_PRIVATE_JWK=' packages/mcp-worker/.dev.vars || fail ".dev.vars is missing MCP_WORKER_SIGNING_PRIVATE_JWK"
grep -q '<random-secret>\|<private-jwk-json>\|<your-deployment>' packages/mcp-worker/.dev.vars && \
  fail "packages/mcp-worker/.dev.vars still contains placeholders"

if command -v lsof >/dev/null 2>&1; then
  for port in 5173 8788; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t | grep -q .; then
      fail "Port $port is already in use. Stop the existing dev service, then rerun pnpm dev:chatgpt."
    fi
  done
fi

log "Starting web app at $LOCAL_WEB_URL"
pnpm dev:web &
PIDS+=("$!")

log "Starting local MCP Worker at $LOCAL_MCP_URL"
pnpm dev:mcp:chatgpt "$PUBLIC_MCP_URL" &
PIDS+=("$!")

log "Starting Cloudflare Tunnel $TUNNEL_NAME ($PUBLIC_MCP_URL → $LOCAL_MCP_URL)"
cloudflared tunnel --config "$TUNNEL_CONFIG" run "$TUNNEL_NAME" &
PIDS+=("$!")

wait_for() {
  local url=$1
  local label=$2
  for _ in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "$label is ready"
      return 0
    fi
    sleep 1
  done
  fail "$label did not become ready: $url"
}

wait_for "$LOCAL_WEB_URL/" "Web app"
wait_for "$LOCAL_MCP_URL/.well-known/oauth-authorization-server" "Local MCP Worker"
wait_for "$PUBLIC_MCP_URL/.well-known/oauth-authorization-server" "Cloudflare Tunnel"

cat <<EOF

ChatGPT local test stack is ready.

  Web app:       $LOCAL_WEB_URL
  MCP server:    $PUBLIC_MCP_URL/mcp
  Convex:        VITE_CONVEX_SITE_URL from .env.local (cloud dev)
  Tunnel config: $TUNNEL_CONFIG

In ChatGPT developer mode, refresh or create the PocketCircle Dev connection
for $PUBLIC_MCP_URL/mcp, verify its tool descriptions, then start a new chat.
Press Ctrl-C here to stop all three local processes.
EOF

wait
