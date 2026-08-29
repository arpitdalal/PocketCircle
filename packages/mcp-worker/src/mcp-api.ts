import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./env.js";

function hostnameOf(urlString: string | undefined) {
  if (!urlString) {
    return null;
  }
  try {
    return new URL(urlString).hostname;
  } catch {
    return null;
  }
}

export function createMcpApiHandler(env: Env, origin?: string) {
  const allowedHostnames = new Set(["mcp.pocketcircle.app", "localhost", "127.0.0.1"]);
  const issuerHost = hostnameOf(env.MCP_ISSUER);
  if (issuerHost) {
    allowedHostnames.add(issuerHost);
  }
  const originHost = hostnameOf(origin);
  if (originHost) {
    allowedHostnames.add(originHost);
  }

  const allowedOriginHostnames = new Set(allowedHostnames);
  allowedOriginHostnames.add("pocketcircle.app");
  const appOriginHost = hostnameOf(env.APP_ORIGIN);
  if (appOriginHost) {
    allowedOriginHostnames.add(appOriginHost);
  }

  // Tools land in #319. `legacy: "reject"` refuses the old SSE transport so we
  // only support the current Streamable HTTP MCP transport.
  const mcpHandler = createMcpHandler(
    () => new McpServer({ name: "PocketCircle MCP", version: "0.1.0" }),
    {
      legacy: "reject",
      allowedHostnames: Array.from(allowedHostnames),
      allowedOriginHostnames: Array.from(allowedOriginHostnames),
    },
  );

  return {
    fetch: mcpHandler,
  } satisfies ExportedHandler<Env>;
}
