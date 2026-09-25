import { LOCAL_APP_HOSTNAME, LOCAL_APP_PORT } from "@pocketcircle/domain/origins";
import { reactRouter } from "@react-router/dev/vite";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { crawlAssets } from "./crawl-assets.js";
import { resolveAppRelease, resolveAppVersion } from "./resolve-app-version.js";

const appVersion = resolveAppVersion();
const appRelease = resolveAppRelease();

/**
 * Serves `robots.txt` and `sitemap.xml` from `crawl-assets.ts` (built from the
 * canonical apex origin, #404) in dev and in the build. They are deliberately
 * not files in `public/`: a checked-in copy is a second place an origin move
 * would have to be applied by hand.
 */
function crawlAssetsPlugin(): Plugin {
  const assets = Object.entries(crawlAssets());
  return {
    name: "pocketcircle:crawl-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const match = assets.find(([fileName]) => request.url === `/${fileName}`);
        if (!match) {
          next();
          return;
        }
        const [fileName, source] = match;
        response.setHeader(
          "Content-Type",
          fileName.endsWith(".xml") ? "application/xml" : "text/plain",
        );
        response.end(source);
      });
    },
    generateBundle() {
      for (const [fileName, source] of assets) {
        this.emitFile({ type: "asset", fileName, source });
      }
    },
  };
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_RELEASE__: JSON.stringify(appRelease),
  },
  // The shared .env.local lives at the monorepo root, so load env from there for
  // both dev and the SPA prerender build (which instantiates the Convex client).
  envDir: "../..",
  server: {
    // Bind IPv4 127.0.0.1 explicitly. Vite's default host is `localhost`, which on
    // this machine resolves to IPv6 `::1` only — so the server never listened on
    // 127.0.0.1, and the Better Auth OAuth callback (SITE_URL, the canonical
    // `LOCAL_APP_ORIGIN`) round-tripped back to a 127.0.0.1 address nothing was
    // listening on (ERR_CONNECTION_REFUSED). Pinning the host to the canonical
    // loopback host keeps the dev server and SITE_URL the same origin.
    host: LOCAL_APP_HOSTNAME,
    port: LOCAL_APP_PORT,
    // CHANGELOG.md lives at the monorepo root (same as envDir). Vite's workspace
    // root detection is not always enough for `?raw` in tests and the dev server.
    fs: {
      allow: ["../.."],
    },
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
    crawlAssetsPlugin(),
    reactRouter(),
  ],
});
