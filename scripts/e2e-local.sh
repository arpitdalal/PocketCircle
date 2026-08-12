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
#   KEEP_BACKEND=1 scripts/e2e-local.sh  # leave the container up afterward (debugging)
#
# The only thing this does NOT mimic is the OS: CI is ubuntu-latest, you are on
# whatever this is. The backend runs in Docker either way, so that gap is small.

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

CONTAINER="pocketcircle-e2e-convex"   # distinct name; never clobbers a stray `convex` container
CONVEX_DIR="$REPO_ROOT/packages/convex"
ENV_LOCAL="$CONVEX_DIR/.env.local"
ENV_LOCAL_BAK="$CONVEX_DIR/.env.local.e2e-local-bak"

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

log() { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }

cleanup() {
  # Restore .env.local if we moved it (always, even on failure).
  if [[ -f "$ENV_LOCAL_BAK" ]]; then
    mv -f "$ENV_LOCAL_BAK" "$ENV_LOCAL"
  fi
  if [[ "${KEEP_BACKEND:-0}" == "1" ]]; then
    echo
    log "KEEP_BACKEND=1 — leaving container '$CONTAINER' running."
    echo "  Inspect:   docker logs $CONTAINER"
    echo "  Tear down: docker rm -f $CONTAINER"
  else
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
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
  pnpm exec convex deploy -y
)

# Restore .env.local before the Playwright run (the trap also covers failure).
if [[ -f "$ENV_LOCAL_BAK" ]]; then
  mv -f "$ENV_LOCAL_BAK" "$ENV_LOCAL"
fi

# --- 4. browsers + run ---------------------------------------------------
log "Ensuring Playwright Chromium is installed"
pnpm exec playwright install chromium

log "Running E2E suite"
pnpm exec playwright test "$@"
