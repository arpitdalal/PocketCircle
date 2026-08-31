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

export function mcpDouble(state: McpState) {
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
  } satisfies EntityDouble;
}

export function makeMcpHandoffView(over: Partial<McpHandoffView> = {}) {
  return {
    handoffId: over.handoffId ?? "handoff-1",
    clientId: over.clientId ?? "https://client.example/client.json",
    clientName: over.clientName ?? "Example Client",
    clientUri: over.clientUri ?? "https://client.example",
    logoUri: over.logoUri,
    redirectUri: over.redirectUri ?? "https://client.example/callback",
    resource: over.resource ?? "https://mcp.pocketcircle.app/mcp",
    scopes: over.scopes ?? ["pocketcircle:read"],
    refreshDurationLabel: over.refreshDurationLabel ?? "30 days",
  } satisfies McpHandoffView;
}
