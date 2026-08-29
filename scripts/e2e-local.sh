#!/usr/bin/env bash
set -euo pipefail

# Reproduce the CI "E2E" job (.github/workflows/e2e.yml) on your machine.
#
# Same true-E2E path as CI (ADR 0019): boot the *pinned* self-hosted Convex
# backend image, deploy this project's functions with the flag-gated
# email+password bypass (E2E_TEST_AUTH=1), then run Playwright against it.
# When CI's E2E job goes red, run this to reproduce the failure locally instead
# of pushing speculative fixes and waiting on CI.
#
# Usage:
#   scripts/e2e-local.sh                 # full run, backend torn down after
#   scripts/e2e-local.sh --headed        # any args pass through to `playwright test`
#   scripts/e2e-local.sh e2e/transactions.spec.ts
#   KEEP_BACKEND=1 scripts/e2e-local.sh  # leave Convex + MCP Worker running (debugging)
#
# The only thing this does NOT mimic is the OS: CI is ubuntu-latest, you are on
# whatever this is. The backend runs in Docker either way, so that gap is small.

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

CONTAINER="pocketcircle-e2e-convex"   # distinct name; never clobbers a stray `convex` container
CONVEX_DIR="$REPO_ROOT/packages/convex"
MCP_DIR="$REPO_ROOT/packages/mcp-worker"
ENV_LOCAL="$CONVEX_DIR/.env.local"
ENV_LOCAL_BAK="$CONVEX_DIR/.env.local.e2e-local-bak"
MCP_PID=""
MCP_LOG=""
MCP_STATE_DIR=""

# Single source of truth for the image: read the SHA-pinned tag straight out of
# the CI workflow so this script can never drift from what CI actually runs.
CONVEX_IMAGE="$(grep -oE 'ghcr.io/get-convex/convex-backend@sha256:[a-f0-9]+' .github/workflows/e2e.yml | head -1)"
if [[ -z "${CONVEX_IMAGE:-}" ]]; then
  echo "✗ Could not read CONVEX_IMAGE from .github/workflows/e2e.yml" >&2
  exit 1
fi

# These mirror the CI job's env. Exporting them makes the run deterministic
# regardless of what the shell or .env.local say.
export CONVEX_SELF_HOSTED_URL="http://127.0.0.1:3210"
export VITE_CONVEX_URL="http://127.0.0.1:3210"
export VITE_CONVEX_SITE_URL="http://127.0.0.1:3211"
export MCP_E2E_WORKER_ORIGIN="http://127.0.0.1:8787"

MCP_HMAC_SECRET="$(openssl rand -hex 32)"
export MCP_E2E_CLIENT_PROVISIONING_TOKEN="$(openssl rand -hex 32)"
MCP_KEY_OUTPUT="$(node scripts/generate-mcp-worker-key.mjs)"
MCP_SIGNING_PRIVATE_JWK="$(printf '%s\n' "$MCP_KEY_OUTPUT" | sed -n '1s/^[^=]*=//p')"
MCP_VERIFYING_JWKS="$(printf '%s\n' "$MCP_KEY_OUTPUT" | sed -n '2s/^[^=]*=//p')"

log() { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }

cleanup() {
  local status=$?
  # Restore .env.local if we moved it (always, even on failure).
  if [[ -f "$ENV_LOCAL_BAK" ]]; then
    mv -f "$ENV_LOCAL_BAK" "$ENV_LOCAL"
  fi
  if [[ "${KEEP_BACKEND:-0}" == "1" ]]; then
    echo
    log "KEEP_BACKEND=1 — leaving Convex and the MCP Worker running."
    echo "  Convex logs: docker logs $CONTAINER"
    echo "  Worker logs: $MCP_LOG"
    echo "  Tear down:   docker rm -f $CONTAINER; kill $MCP_PID"
  else
    if [[ -n "$MCP_PID" ]]; then
      kill "$MCP_PID" >/dev/null 2>&1 || true
      wait "$MCP_PID" >/dev/null 2>&1 || true
    fi
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    if [[ "$status" != "0" && -n "$MCP_LOG" && -f "$MCP_LOG" ]]; then
      echo "MCP Worker logs:" >&2
      tail -n 200 "$MCP_LOG" >&2
    fi
    if [[ -n "$MCP_STATE_DIR" && -d "$MCP_STATE_DIR" ]]; then
      rm -rf -- "$MCP_STATE_DIR"
    fi
    if [[ -n "$MCP_LOG" ]]; then
      rm -f -- "$MCP_LOG"
    fi
  fi
  return "$status"
}
trap cleanup EXIT

# --- preflight ------------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  echo "✗ Docker is not running. Start Docker Desktop (or the daemon) and retry." >&2
  exit 1
fi

# --- 1. boot the self-hosted backend -------------------------------------
log "Booting self-hosted Convex backend ($CONTAINER)"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true   # idempotent: clear a prior run
docker run -d --name "$CONTAINER" \
  -p 3210:3210 -p 3211:3211 \
  -e CONVEX_CLOUD_ORIGIN=http://127.0.0.1:3210 \
  -e CONVEX_SITE_ORIGIN=http://127.0.0.1:3211 \
  -e DISABLE_BEACON=true \
  "$CONVEX_IMAGE" >/dev/null

log "Waiting for backend to accept connections…"
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3210/version >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 2
done
if [[ "${ready:-0}" != "1" ]]; then
  echo "✗ Backend never became ready. Logs:" >&2
  docker logs "$CONTAINER" >&2 || true
  exit 1
fi

# --- 2. admin key --------------------------------------------------------
log "Generating admin key"
export CONVEX_SELF_HOSTED_ADMIN_KEY="$(docker exec "$CONTAINER" ./generate_admin_key.sh | tail -n1 | tr -d '\r')"

# --- 3. configure test-only auth env + deploy ----------------------------
# `convex` errors if CONVEX_DEPLOYMENT is set alongside the self-hosted vars
# (deploymentSelection.js). Your gitignored .env.local points at the cloud dev
# deployment; CI has no such file. Move it aside for the deploy (restored by the
# trap) so the CLI sees only the self-hosted target — exactly like CI.
if [[ -f "$ENV_LOCAL" ]]; then
  log "Moving packages/convex/.env.local aside for the deploy (restored on exit)"
  mv -f "$ENV_LOCAL" "$ENV_LOCAL_BAK"
fi

log "Configuring test-only auth env + deploying functions"
(
  cd "$CONVEX_DIR"
  pnpm exec convex env set BETTER_AUTH_SECRET "local-$(openssl rand -hex 16)"
  pnpm exec convex env set SITE_URL "http://127.0.0.1:5173"
  pnpm exec convex env set GOOGLE_CLIENT_ID "local-dummy"
  pnpm exec convex env set GOOGLE_CLIENT_SECRET "local-dummy"
  pnpm exec convex env set E2E_TEST_AUTH "1"
  pnpm exec convex env set MCP_WORKER_HMAC_SECRET "$MCP_HMAC_SECRET"
  pnpm exec convex env set MCP_WORKER_VERIFYING_JWKS "$MCP_VERIFYING_JWKS"
  pnpm exec convex deploy -y
)

# Restore .env.local before the Playwright run (the trap also covers failure).
if [[ -f "$ENV_LOCAL_BAK" ]]; then
  mv -f "$ENV_LOCAL_BAK" "$ENV_LOCAL"
fi

# --- 4. boot the real local MCP Worker -----------------------------------
MCP_LOG="$(mktemp "${TMPDIR:-/tmp}/pocketcircle-mcp-e2e.XXXXXX")"
MCP_STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pocketcircle-mcp-e2e-state.XXXXXX")"
log "Booting local MCP Worker with Wrangler"
(
  cd "$MCP_DIR"
  exec pnpm exec wrangler dev --local --ip 127.0.0.1 --port 8787 \
    --persist-to "$MCP_STATE_DIR" \
    --var "APP_ORIGIN:http://127.0.0.1:5173" \
    --var "CONVEX_SITE_URL:$VITE_CONVEX_SITE_URL" \
    --var "MCP_WORKER_HMAC_SECRET:$MCP_HMAC_SECRET" \
    --var "MCP_WORKER_SIGNING_PRIVATE_JWK:$MCP_SIGNING_PRIVATE_JWK" \
    --var "MCP_CLIENT_PROVISIONING_TOKEN:$MCP_E2E_CLIENT_PROVISIONING_TOKEN"
) >"$MCP_LOG" 2>&1 &
MCP_PID=$!

log "Waiting for MCP Worker to accept connections…"
for _ in $(seq 1 60); do
  if curl -fsS "$MCP_E2E_WORKER_ORIGIN/.well-known/oauth-authorization-server" >/dev/null 2>&1; then
    mcp_ready=1; break
  fi
  if ! kill -0 "$MCP_PID" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if [[ "${mcp_ready:-0}" != "1" ]]; then
  echo "✗ MCP Worker never became ready. Logs:" >&2
  tail -n 200 "$MCP_LOG" >&2 || true
  exit 1
fi

# --- 5. browsers + run ---------------------------------------------------
log "Ensuring Playwright Chromium is installed"
pnpm exec playwright install chromium

log "Running E2E suite"
pnpm exec playwright test "$@"
