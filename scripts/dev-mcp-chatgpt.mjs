import { spawn } from "node:child_process";

// Keep public OAuth discovery consistent with the tunnel while using local KV,
// Durable Objects, and the Convex dev credentials in .dev.vars.
const [originArg, ...extraArgs] = process.argv.slice(2);
let origin;
try {
  const url = new URL(originArg);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.hostname === "mcp.pocketcircle.app" ||
    extraArgs.length
  ) {
    throw new Error("Expected a development tunnel HTTPS origin.");
  }
  origin = url.origin;
} catch {
  console.error("Usage: pnpm dev:mcp:chatgpt https://YOUR-DEVELOPMENT-TUNNEL-HOST");
  process.exit(1);
}

const worker = spawn(
  "pnpm",
  [
    "--filter",
    "@pocketcircle/mcp-worker",
    "exec",
    "wrangler",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    "8788",
    "--var",
    `MCP_ISSUER:${origin}`,
    "--var",
    `MCP_RESOURCE_URI:${origin}/mcp`,
    "--var",
    "MCP_CIMD_ENABLED:false",
  ],
  {
    stdio: "inherit",
    // A tunnel must not expose Wrangler's local storage explorer.
    env: { ...process.env, X_LOCAL_EXPLORER: "false" },
  },
);
worker.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
worker.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => worker.kill(signal));
}
