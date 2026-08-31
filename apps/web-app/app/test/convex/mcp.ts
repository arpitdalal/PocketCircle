import { api } from "@pocketcircle/convex";
import { getFunctionName } from "convex/server";
import type { Mock } from "vitest";
import type { McpConnection, McpHandoffView } from "~/lib/data.js";
import type { EntityDouble } from "./contract.js";
import { testId } from "./ids.js";

export interface McpState {
  /** `parseMcpHandoff` — `undefined` ≡ loading, `null` ≡ invalid/expired. */
  mcpHandoff?: McpHandoffView | null;
  mcpConnections?: McpConnection[];
  approveMcpAuthorization?: Mock;
  revokeMcpConnection?: Mock;
}

export function mcpDouble(state: McpState) {
  const { mcpHandoff, mcpConnections, approveMcpAuthorization, revokeMcpConnection } = state;
  return {
    queries: {
      [getFunctionName(api.mcpConsent.parseMcpHandoff)]: () => mcpHandoff,
      [getFunctionName(api.mcpConnections.listMcpConnections)]: () => mcpConnections,
    },
    mutations: {
      ...(approveMcpAuthorization
        ? { [getFunctionName(api.mcpConsent.approveMcpAuthorization)]: approveMcpAuthorization }
        : {}),
      ...(revokeMcpConnection
        ? { [getFunctionName(api.mcpConnections.revokeMcpConnection)]: revokeMcpConnection }
        : {}),
    },
  } satisfies EntityDouble;
}

export function makeMcpConnectionView(over: Partial<McpConnection> = {}) {
  const circleId = testId<McpConnection["selectedCircles"][number]["id"]>("circle-selected");
  return {
    id: testId<McpConnection["id"]>("connection-1"),
    clientId: "https://client.example/client.json",
    clientName: "Example Client",
    clientUri: "https://client.example",
    logoUri: null,
    redirectUri: "https://client.example/callback",
    scopes: ["pocketcircle:read"],
    selectedCircles: [
      {
        id: circleId,
        ref: "shared-trip-circle-selected",
        name: "Shared Trip",
        kind: "regular",
        currency: "USD",
        color: "blue",
        mark: "S",
        status: "active",
        setupComplete: true,
        currencyLocked: false,
        isOwner: true,
      },
    ],
    createdAt: 1,
    status: "active",
    lastUsedAt: null,
    workerCleanupStatus: "none",
    ...over,
  } satisfies McpConnection;
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
