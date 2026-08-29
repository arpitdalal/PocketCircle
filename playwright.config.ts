import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against a REAL, self-hosted Convex backend (ADR 0019):
 * the real frontend → Convex functions → DB path. Google OAuth is replaced by the
 * flag-gated email+password bypass (E2E_TEST_AUTH on the backend, VITE_E2E on the
 * app); outbound vendors are MSW-mocked once they exist. There is no mock-mode
 * E2E suite — fast UI checks live in the Vitest render tests (e.g. home.test.tsx).
 *
 * Auth: each Playwright worker gets its own User + Personal Circle via
 * `e2e/fixtures.ts` (per-worker `storageState` under `e2e/.auth/worker-*.json`), so
 * parallel desktop/mobile projects do not share one Circle.
 *
 * The CI workflow sets VITE_CONVEX_URL / VITE_CONVEX_SITE_URL to the self-hosted
 * backend's origins; locally they default to the docker-compose ports.
 */
const PORT = 5173;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Playwright otherwise uses 50% of detected CPUs. Pin CI to the measured-safe two:
  // 4 workers overwhelmed one Convex container. CI scales through three shards, each
  // with its own backend, instead of adding contention within a shard.
  workers: process.env.CI ? 2 : undefined,
  // Shards upload mergeable blobs; the final CI job emits GitHub annotations and one
  // seven-day HTML report. Local runs keep the readable terminal reporter.
  reporter: process.env.CI ? "blob" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "pnpm --filter @pocketcircle/web-app dev --host 127.0.0.1",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      VITE_E2E: "true",
      // Empty so Vite does not load a real key from `.env.local`. New E2E users
      // default analytics on; without this the suite can capture to PostHog.
      VITE_POSTHOG_KEY: "",
      VITE_CONVEX_URL: process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210",
      VITE_CONVEX_SITE_URL: process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211",
      ...(process.env.MCP_E2E_WORKER_ORIGIN
        ? { VITE_MCP_WORKER_ORIGIN: process.env.MCP_E2E_WORKER_ORIGIN }
        : {}),
    },
  },
});
