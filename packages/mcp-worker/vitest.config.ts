import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Secrets are not in wrangler vars; tests supply fixed signing material.
          MCP_WORKER_HMAC_SECRET: "test-mcp-worker-secret",
          MCP_WORKER_SIGNING_PRIVATE_JWK:
            '{"key_ops":["sign"],"ext":true,"kty":"EC","x":"pUT8Qgi_S3CzQeEpsVsOpOWQtHQffFeyQnrDn0Ez_hM","y":"ZJUnZqOxoZZmmnrivG1fFpw7BfeHBEfGGoVA2Y0Q7Vo","crv":"P-256","d":"HQgOJVhMah1F2_TIH_2T3tSXYMUxMCYx_0trUiMrpVI","kid":"test-current","alg":"ES256"}',
          MCP_CLIENT_PROVISIONING_TOKEN: "test-client-provisioning-token-at-least-32-bytes",
        },
      },
    }),
  ],
  test: {
    name: "mcp-worker",
    include: ["src/**/*.test.ts"],
  },
});
