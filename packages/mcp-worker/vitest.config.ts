import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Secrets are not in wrangler vars; tests supply a fixed HMAC.
          MCP_WORKER_HMAC_SECRET: "test-mcp-worker-secret",
        },
      },
    }),
  ],
  test: {
    name: "mcp-worker",
    include: ["src/**/*.test.ts"],
  },
});
