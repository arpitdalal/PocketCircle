import { api } from "@pocketcircle/convex";
import { getFunctionName } from "convex/server";
import type { Mock } from "vitest";
import type { McpHandoffView } from "~/lib/data.js";
import type { EntityDouble } from "./contract.js";

export interface McpState {
  /** `parseMcpHandoff` — `undefined` ≡ loading, `null` ≡ invalid/expired. */
  mcpHandoff?: McpHandoffView | null;
  approveMcpAuthorization?: Mock;
}

export function mcpDouble(state: McpState): EntityDouble {
  const { mcpHandoff, approveMcpAuthorization } = state;
  return {
    queries: {
      [getFunctionName(api.mcpConsent.parseMcpHandoff)]: () => mcpHandoff,
    },
    mutations: {
      ...(approveMcpAuthorization
        ? { [getFunctionName(api.mcpConsent.approveMcpAuthorization)]: approveMcpAuthorization }
        : {}),
    },
  };
}

export function makeMcpHandoffView(over: Partial<McpHandoffView> = {}): McpHandoffView {
  return {
    handoffId: "handoff-1",
    clientId: "https://client.example/client.json",
    clientName: "Example Client",
    clientUri: "https://client.example",
    logoUri: undefined,
    redirectUri: "https://client.example/callback",
    resource: "https://mcp.pocketcircle.app/mcp",
    scopes: ["pocketcircle:read"],
    refreshDurationLabel: "30 days",
    ...over,
  };
}
