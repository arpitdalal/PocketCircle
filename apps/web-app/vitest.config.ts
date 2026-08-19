import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineProject } from "vitest/config";
import { resolveAppRelease, resolveAppVersion } from "./resolve-app-version.js";

// Component tests run under jsdom with the React plugin only — the React Router
// Vite plugin is intentionally excluded so tests render components directly.
// The React Compiler preset matches production (vite.config.ts) so unit tests
// exercise compiled output, not a separate uncompiled code path.
const appVersion = resolveAppVersion();
const appRelease = resolveAppRelease();

export default defineProject({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_RELEASE__: JSON.stringify(appRelease),
  },
  plugins: [babel({ presets: [reactCompilerPreset()] }), react()],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    fs: {
      allow: ["../.."],
    },
  },
  test: {
    name: "web-app",
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["app/**/*.test.{ts,tsx}", "resolve-app-version.test.ts"],
  },
});
