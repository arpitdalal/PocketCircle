import { buildRef } from "@pocketcircle/domain";
import type { convexTest } from "convex-test";
import type { Id } from "../convex/_generated/dataModel.js";
import { activateMcpGrant, createPendingMcpGrant } from "../convex/mcpGrant.js";
import {
  addMember,
  seedOwnedFixture,
  seedPersonalCircleOwner,
  seedPersonalFixture,
  seedTransaction,
} from "./seed.js";

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

/**
 * Shared plugin-evaluation fixture (#365): one authorized Circle, one owned but
 * denied Circle (not on the grant), plus helpers to revoke the connection.
 */
export async function seedMcpPluginEvalFixture(t: TestCtx) {
  const owner = await t.run((ctx) =>
    seedPersonalCircleOwner(ctx, {
      email: "plugin-eval@example.com",
      displayName: "Plugin Eval Owner",
    }),
  );
  const authorized = await t.run((ctx) =>
    seedOwnedFixture(ctx, owner.owner, { name: "Authorized Trip", currency: "USD" }),
  );
  const denied = await t.run((ctx) =>
    seedOwnedFixture(ctx, owner.owner, { name: "Denied Home", currency: "CAD" }),
  );
  const grant = await createActiveMcpGrant(t, {
    userId: owner.userId,
    circleIds: [authorized.circleId],
    scopes: ["pocketcircle:read"],
    clientId: DEFAULT_CLIENT_ID,
    clientKind: "static",
    redirectUri: DEFAULT_REDIRECT_URI,
  });
  return {
    owner,
    authorized,
    denied,
    grant,
    authorizedCircleRef: buildRef("Authorized Trip", authorized.circleId),
    deniedCircleRef: buildRef("Denied Home", denied.circleId),
    async revokeGrant() {
      await t.run((ctx) => ctx.db.patch(grant._id, { status: "revoked", revokedAt: Date.now() }));
    },
  };
}

/** Shared spending-review fixture (#366): attribution, exclusions, currencies, categories, and archival. */
export async function seedMcpSpendingReviewFixture(t: TestCtx) {
  const personal = await t.run((ctx) =>
    seedPersonalFixture(ctx, {
      email: "spending-review@example.com",
      displayName: "Spending Review Owner",
      currency: "USD",
    }),
  );
  const trip = await t.run((ctx) =>
    seedOwnedFixture(ctx, personal.owner, { name: "Review Trip", currency: "USD" }),
  );
  const archived = await t.run((ctx) =>
    seedOwnedFixture(ctx, personal.owner, {
      name: "Archived Review Trip",
      currency: "CAD",
      archived: true,
    }),
  );
  const tripMember = await t.run((ctx) =>
    addMember(ctx, trip.circleId, "review-member@example.com", "Review Member"),
  );

  await t.run(async (ctx) => {
    await seedTransaction(ctx, personal, {
      title: "Personal groceries",
      amountMinorUnits: 1_000,
      date: "2026-09-03",
      categoryIds: [personal.groceriesId, personal.diningId],
    });
    await seedTransaction(ctx, trip, {
      title: "Member paid trip expense",
      amountMinorUnits: 2_000,
      date: "2026-09-04",
      recordedByMemberId: trip.ownerMemberId,
      paidByMemberId: tripMember.memberId,
    });
    await seedTransaction(ctx, trip, {
      title: "Personal trip expense",
      amountMinorUnits: 500,
      date: "2026-09-05",
      paidByMemberId: trip.ownerMemberId,
    });
    await seedTransaction(ctx, trip, {
      title: "Archived transaction",
      amountMinorUnits: 900,
      date: "2026-09-06",
      status: "archived",
    });
    await seedTransaction(ctx, archived, {
      title: "Archived Circle expense",
      amountMinorUnits: 800,
      date: "2026-09-07",
    });
  });

  const grant = await createActiveMcpGrant(t, {
    userId: personal.owner._id,
    circleIds: [personal.circleId, trip.circleId, archived.circleId],
    scopes: ["pocketcircle:read"],
  });
  return {
    personal,
    trip,
    archived,
    tripMember,
    grant,
    personalCircleRef: buildRef("Spending's Circle", personal.circleId),
    tripCircleRef: buildRef("Review Trip", trip.circleId),
    archivedCircleRef: buildRef("Archived Review Trip", archived.circleId),
  };
}
