import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./env.js";

// Tools land in #319. `legacy: "reject"` refuses the old SSE transport so we
// only support the current Streamable HTTP MCP transport.
const mcpHandler = createMcpHandler(
  () => new McpServer({ name: "PocketCircle MCP", version: "0.1.0" }),
  {
    legacy: "reject",
  },
);

export const mcpApiHandler = {
  fetch: mcpHandler,
} satisfies ExportedHandler<Env>;
