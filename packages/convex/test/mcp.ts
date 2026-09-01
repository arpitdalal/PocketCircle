import type { convexTest } from "convex-test";
import type { Id } from "../convex/_generated/dataModel.js";
import { activateMcpGrant, createPendingMcpGrant } from "../convex/mcpGrant.js";

type TestCtx = ReturnType<typeof convexTest>;

export async function createActiveMcpGrant(
  t: TestCtx,
  args: {
    userId: Id<"users">;
    circleIds: string[];
    scopes?: readonly string[];
    clientId?: string;
    clientKind?: "cimd" | "static";
    redirectUri?: string;
    workerGrantId?: string;
  },
) {
  const pending = await t.run((ctx) =>
    createPendingMcpGrant(ctx, {
      userId: args.userId,
      clientId: args.clientId ?? "https://mcp-client.example/client.json",
      clientKind: args.clientKind ?? "cimd",
      redirectUri: args.redirectUri ?? "https://mcp-client.example/callback",
      clientDisplaySnapshot: { clientName: "Example Client" },
      scopes: args.scopes ?? ["pocketcircle:read", "pocketcircle:write"],
      allowedCircleIds: args.circleIds,
    }),
  );
  if (!pending.ok) {
    throw new Error(pending.error);
  }
  const activated = await t.run((ctx) =>
    activateMcpGrant(ctx, {
      grantId: pending.value._id,
      workerGrantId: args.workerGrantId ?? `worker-${pending.value._id}`,
      principalId: pending.value.principalId,
    }),
  );
  if (!activated.ok) {
    throw new Error(activated.error);
  }
  return activated.value;
}
