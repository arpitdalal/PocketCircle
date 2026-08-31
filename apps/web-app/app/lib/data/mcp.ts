/**
 * MCP consent data seam (#318). Routes talk to Convex through these hooks —
 * never import Convex function refs from route modules.
 */

import { api } from "@pocketcircle/convex";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { MOCKS } from "../env.js";

export type McpHandoffView = NonNullable<FunctionReturnType<typeof api.mcpConsent.parseMcpHandoff>>;
export type McpConnection = FunctionReturnType<
  typeof api.mcpConnections.listMcpConnections
>["page"][number];

export const MCP_CONNECTIONS_PAGE_SIZE = 20;

/** Verified handoff display fields, or null when invalid/expired. undefined = loading. */
export function useMcpHandoff(handoff: string | null) {
  const queried = useQuery(
    api.mcpConsent.parseMcpHandoff,
    MOCKS || !handoff ? "skip" : { handoff },
  );
  if (MOCKS || !handoff) {
    return null;
  }
  return queried;
}

export function useApproveMcpAuthorization() {
  return useMutation(api.mcpConsent.approveMcpAuthorization);
}

/** Current User's MCP connections; mock mode keeps the shell renderable offline. */
export function useMcpConnections() {
  const paginated = usePaginatedQuery(api.mcpConnections.listMcpConnections, MOCKS ? "skip" : {}, {
    initialNumItems: MCP_CONNECTIONS_PAGE_SIZE,
  });
  if (MOCKS) {
    return { connections: [], status: "Exhausted" as const, loadMore: () => {} };
  }
  return {
    connections: paginated.results,
    status: paginated.status,
    loadMore: () => paginated.loadMore(MCP_CONNECTIONS_PAGE_SIZE),
  };
}

export function useRevokeMcpConnection() {
  return useMutation(api.mcpConnections.revokeMcpConnection);
}

/** Sends the Convex-issued, single-connection cleanup capability to the Worker. */
export async function completeMcpConnectionRevocation(
  workerOrigin: string,
  revocationToken: string,
) {
  const response = await fetch(new URL("/revoke", workerOrigin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revocationToken }),
  });
  if (!response.ok) {
    throw new Error("MCP Worker cleanup failed");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("revoked" in payload) ||
    payload.revoked !== true
  ) {
    throw new Error("MCP Worker cleanup failed");
  }
}
