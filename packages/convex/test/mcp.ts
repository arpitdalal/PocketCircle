import { buildRef } from "@pocketcircle/domain";
import type { convexTest } from "convex-test";
import type { Id } from "../convex/_generated/dataModel.js";
import { activateMcpGrant, createPendingMcpGrant } from "../convex/mcpGrant.js";
import { addMember, seedOwnedFixture, seedPersonalCircleOwner } from "./seed.js";

type TestCtx = ReturnType<typeof convexTest>;

const DEFAULT_CLIENT_ID = "https://client.example/client.json";
const DEFAULT_REDIRECT_URI = "https://client.example/callback";
const READ_WRITE = ["pocketcircle:read", "pocketcircle:write"] as const;

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

/** Shared MCP write-suite fixture: owner, circle, member, grant(s). */
export async function seedMcpWriteFixture(
  t: TestCtx,
  options?: {
    includeMemberGrant?: boolean;
    ownerEmail?: string;
    clientId?: string;
    redirectUri?: string;
  },
) {
  const clientId = options?.clientId ?? DEFAULT_CLIENT_ID;
  const redirectUri = options?.redirectUri ?? DEFAULT_REDIRECT_URI;
  const owner = await t.run((ctx) =>
    seedPersonalCircleOwner(ctx, {
      email: options?.ownerEmail ?? "writer@example.com",
      displayName: "Writer Owner",
    }),
  );
  const f = await t.run((ctx) =>
    seedOwnedFixture(ctx, owner.owner, { name: "Trip", currency: "USD" }),
  );
  const member = await t.run((ctx) =>
    addMember(ctx, f.circleId, "maya@example.com", "Maya Member"),
  );
  const grant = await createActiveMcpGrant(t, {
    userId: owner.userId,
    circleIds: [f.circleId],
    scopes: READ_WRITE,
    clientId,
    clientKind: "static",
    redirectUri,
  });
  const circleRef = buildRef("Trip", f.circleId);
  if (!options?.includeMemberGrant) {
    return { owner, f, member, grant, circleRef };
  }
  const memberGrant = await createActiveMcpGrant(t, {
    userId: member.user._id,
    circleIds: [f.circleId],
    scopes: READ_WRITE,
    clientId: `${clientId}/member`,
    clientKind: "static",
    redirectUri,
  });
  return { owner, f, member, grant, memberGrant, circleRef };
}
