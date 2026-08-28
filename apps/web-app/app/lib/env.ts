/**
 * Centralized access to client environment. `MOCKS` couples MSW vendor mocking
 * and the dev auth bypass behind a single flag (ADR 0006). Reading it through
 * one module keeps the `import.meta.env.VITE_MOCKS` check in a single place so
 * the production build can dead-code-eliminate everything it guards.
 */
export const MOCKS = import.meta.env.VITE_MOCKS === "true";

/**
 * True-E2E mode (ADR 0019): the app runs against a REAL self-hosted Convex backend
 * with the real session path and real queries — NOT the `MOCKS` fixtures path. It
 * only enables the gated test-auth helper (so Playwright can establish a session
 * without Google). Build-time constant, so prod drops everything it guards.
 */
export const E2E = import.meta.env.VITE_E2E === "true";

export const CONVEX_URL = import.meta.env.VITE_CONVEX_URL;

function optionalEnvString(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isLocalHostname(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/**
 * MCP Worker origin for consent complete/deny POSTs (#318). Unset or invalid
 * origin → consent UI shows a configuration error instead of posting approval
 * material elsewhere. Non-HTTPS schemes are rejected except on local dev.
 */
export function mcpWorkerOrigin() {
  const raw = optionalEnvString(import.meta.env.VITE_MCP_WORKER_ORIGIN);
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") {
      return url.origin;
    }
    if (url.protocol === "http:" && isLocalHostname(url.hostname)) {
      return url.origin;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Sentry DSN for client error monitoring (ADR 0012). Unset locally → init no-ops. */
export const SENTRY_DSN = optionalEnvString(import.meta.env.VITE_SENTRY_DSN);

/**
 * PostHog key/host are read at call time so tests can `vi.stubEnv` without
 * mocking this module (ADR 0006). Static `import.meta.env.VITE_*` access lets
 * Vite inline the values in production. Unset → analytics no-op.
 */
export function posthogKey() {
  return optionalEnvString(import.meta.env.VITE_POSTHOG_KEY);
}

export function posthogHost() {
  return optionalEnvString(import.meta.env.VITE_POSTHOG_HOST) ?? "https://us.i.posthog.com";
}
