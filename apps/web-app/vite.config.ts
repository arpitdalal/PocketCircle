import { reactRouter } from "@react-router/dev/vite";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { resolveAppVersion } from "./resolve-app-version.js";

const appVersion = resolveAppVersion();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  // The shared .env.local lives at the monorepo root, so load env from there for
  // both dev and the SPA prerender build (which instantiates the Convex client).
  envDir: "../..",
  server: {
    // Bind IPv4 127.0.0.1 explicitly. Vite's default host is `localhost`, which on
    // this machine resolves to IPv6 `::1` only — so the server never listened on
    // 127.0.0.1, and the Better Auth OAuth callback (SITE_URL=http://127.0.0.1:5173)
    // round-tripped back to a 127.0.0.1 address nothing was listening on
    // (ERR_CONNECTION_REFUSED). Pinning the host to 127.0.0.1 matches SITE_URL.
    host: "127.0.0.1",
    port: 5173,
  },
  optimizeDeps: {
    // React Router's SPA entry is a virtual module the dep scanner can't crawl
    // statically, so without explicit entries Vite discovers every dependency at
    // runtime on the first page load and reloads once to re-bundle them. That
    // cold-start reload races the E2E auth bootstrap (e2e/global-setup.ts) and
    // intermittently times it out. Pointing the scanner at the app source (minus
    // tests) makes it pre-bundle the whole graph up front — convex, better-auth,
    // and any transitive dep of a shared workspace package (e.g. zod via the
    // domain schemas) — so the first load is stable. This scales: new deps behind
    // shared packages are found automatically, with no per-dep include list.
    entries: ["app/**/*.{ts,tsx}", "!app/**/*.test.{ts,tsx}"],
  },
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    tailwindcss(),
    // React Compiler. Vite 8 ships Rolldown and React Router framework mode does
    // its own React transform (no @vitejs/plugin-react in the build), so the
    // compiler runs as a standalone Rolldown-native Babel pass via
    // @rolldown/plugin-babel. Its DEFAULT_INCLUDE already covers .ts/.tsx (and
    // excludes node_modules), so no filter is needed — reactCompilerPreset() just
    // wires babel-plugin-react-compiler. Must run before reactRouter() so the
    // compiler sees original source. React 19 ⇒ no runtime/target option.
    //
    // Escape hatch: add `"use no memo"` at the top of a component (or module) to
    // opt out of compilation when a deliberate Rules-of-React exception is
    // required (e.g. adjust-during-render via useValueChange, a ref mirror for
    // event handlers). Document why in a one-line comment. Prefer fixing the
    // pattern first; opt-out is last resort. ESLint (lint:react-compiler) and
    // vitest.config.ts mirror this compiler pass so CI catches miscompiles.
    babel({ presets: [reactCompilerPreset()] }),
    reactRouter(),
  ],
});
