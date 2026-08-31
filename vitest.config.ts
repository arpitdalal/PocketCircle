import { defineConfig } from "vitest/config";

// Each package/app owns its own Vitest config (node, edge-runtime, or jsdom
// environments differ); `test.projects` aggregates them so a single
// `pnpm test` at the root runs the whole suite. (Replaces the deprecated
// vitest.workspace.ts, removed in Vitest 4.)
export default defineConfig({
  test: {
    projects: [
      "packages/domain/vitest.config.ts",
      "packages/convex/vitest.config.ts",
      "packages/mcp-worker/vitest.config.ts",
      "apps/web-app/vitest.config.ts",
    ],
  },
});
