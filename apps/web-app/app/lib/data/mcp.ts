/**
 * MCP consent data seam (#318). Routes talk to Convex through these hooks —
 * never import Convex function refs from route modules.
 */

import { api } from "@pocketcircle/convex";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { MOCKS } from "../env.js";

export type McpHandoffView = NonNullable<FunctionReturnType<typeof api.mcpConsent.parseMcpHandoff>>;

/** Verified handoff display fields, or null when invalid/expired. undefined = loading. */
export function useMcpHandoff(handoff: string | null): McpHandoffView | null | undefined {
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
