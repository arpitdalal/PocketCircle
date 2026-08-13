/// <reference types="vite/client" />

/** Injected at build time from the deploy SHA (`APP_RELEASE_SHA`) or `local-dev`. */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_CONVEX_URL: string;
  readonly VITE_CONVEX_SITE_URL: string;
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
