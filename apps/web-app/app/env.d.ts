/// <reference types="vite/client" />

/** Human-facing release tag injected at build time, or `local-dev`. */
declare const __APP_VERSION__: string;
/** Telemetry release: human-facing tag plus immutable commit SHA. */
declare const __APP_RELEASE__: string;

interface ImportMetaEnv {
  readonly VITE_CONVEX_URL: string;
  readonly VITE_CONVEX_SITE_URL: string;
  /** MCP Worker origin (consent complete/deny). Optional until Worker is running. */
  readonly VITE_MCP_WORKER_ORIGIN?: string;
  /** When "true", enables mock mode: MSW vendor mocking + dev auth bypass. */
  readonly VITE_MOCKS?: string;
  /** When "true", true-E2E mode: real backend + real session + gated test-auth helper (ADR 0019). */
  readonly VITE_E2E?: string;
  /** Sentry ingest DSN for client error monitoring (ADR 0012). Optional locally. */
  readonly VITE_SENTRY_DSN?: string;
  /** PostHog project key for product analytics (ADR 0013). Optional locally. */
  readonly VITE_POSTHOG_KEY?: string;
  /** PostHog ingest host. Optional; defaults to PostHog cloud. */
  readonly VITE_POSTHOG_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
