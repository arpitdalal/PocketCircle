import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Keep consent redirects and Convex site stable even when a local
          // `.dev.vars` overrides wrangler `vars` for manual `wrangler dev`.
          APP_ORIGIN: "https://pocketcircle.app",
          CONVEX_SITE_URL: "https://placeholder.convex.site",
          // Secrets are not in wrangler vars; tests supply fixed signing material.
          MCP_WORKER_HMAC_SECRET: "test-mcp-worker-secret",
          MCP_WORKER_SIGNING_PRIVATE_JWK:
            '{"key_ops":["sign"],"ext":true,"kty":"EC","x":"pUT8Qgi_S3CzQeEpsVsOpOWQtHQffFeyQnrDn0Ez_hM","y":"ZJUnZqOxoZZmmnrivG1fFpw7BfeHBEfGGoVA2Y0Q7Vo","crv":"P-256","d":"HQgOJVhMah1F2_TIH_2T3tSXYMUxMCYx_0trUiMrpVI","kid":"test-current","alg":"ES256"}',
          MCP_CLIENT_PROVISIONING_TOKEN: "test-client-provisioning-token-at-least-32-bytes",
          // Empty clears Cursor-local pins from `.dev.vars` (see .dev.vars.example).
          MCP_ISSUER: "",
          MCP_RESOURCE_URI: "",
          // Matches wrangler.jsonc prod default so Cursor-like DCR tests pass.
          MCP_DCR_ALLOWED_SCHEMES: "cursor,vscode",
        },
      },
    }),
  ],
  test: {
    name: "mcp-worker",
    include: ["src/**/*.test.ts"],
    // Rate-limit bindings share Worker-local counters across the pool; parallel
    // files race the write/destructive suites (#331).
    fileParallelism: false,
  },
});
