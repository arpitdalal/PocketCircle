import { verifyMcpRevocation } from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockCurrentUser, signInAs } from "../test/mockAuth.js";
import { seedOwnedCircle, seedPersonalCircleOwner } from "../test/seed.js";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { activateMcpGrant, createPendingMcpGrant } from "./mcpGrant.js";
import schema from "./schema.js";

vi.mock("./auth.js", async () => (await import("../test/mockAuth.js")).authMockModule());

const modules = import.meta.glob("./**/*.ts");
const CLIENT = "https://mcp-client.example/client.json";

beforeEach(() => {
  resetMockCurrentUser();
  vi.stubEnv("MCP_WORKER_HMAC_SECRET", "test-mcp-worker-secret");
});

async function makeActiveGrant(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  circleId: Id<"circles">,
) {
  const pending = await t.run((ctx) =>
    createPendingMcpGrant(ctx, {
      userId,
      clientId: CLIENT,
      clientKind: "cimd",
      redirectUri: "https://mcp-client.example/callback",
      clientDisplaySnapshot: {
        clientName: "Ledger Assistant",
        clientUri: "https://mcp-client.example",
        logoUri: "https://mcp-client.example/logo.png",
      },
      scopes: ["pocketcircle:read"],
      allowedCircleIds: [circleId],
    }),
  );
  if (!pending.ok) {
    throw new Error(pending.error);
  }
  const active = await t.run((ctx) =>
    activateMcpGrant(ctx, {
      grantId: pending.value._id,
      workerGrantId: "worker-grant-opaque",
      principalId: pending.value.principalId,
    }),
  );
  if (!active.ok) {
    throw new Error(active.error);
  }
  return active.value;
}

describe("MCP Connections view", () => {
  it("lists safe metadata and current visible selected Circles", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada Lovelace",
        onboarded: true,
      }),
    );
    const extra = await t.run((ctx) =>
      seedOwnedCircle(ctx, ada.owner, { name: "Shared Trip", setupCompletedAt: Date.now() }),
    );
    const grant = await makeActiveGrant(t, ada.userId, extra.circleId);

    signInAs(ada.owner);
    const connections = await t.query(api.mcpConnections.listMcpConnections, {});

    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      id: grant._id,
      clientId: CLIENT,
      clientName: "Ledger Assistant",
      clientUri: "https://mcp-client.example",
      redirectUri: "https://mcp-client.example/callback",
      scopes: ["pocketcircle:read"],
      selectedCircles: [expect.objectContaining({ id: extra.circleId, name: "Shared Trip" })],
      status: "active",
      lastUsedAt: null,
      workerCleanupStatus: "none",
    });
    expect(connections[0]).not.toHaveProperty("principalId");
    expect(connections[0]).not.toHaveProperty("workerGrantId");
  });

  it("rejects forged connection ids without touching another User's grant", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada Lovelace",
        onboarded: true,
      }),
    );
    const grace = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "grace@example.com",
        displayName: "Grace Hopper",
        onboarded: true,
      }),
    );
    const grant = await makeActiveGrant(t, ada.userId, ada.personalCircleId);

    signInAs(grace.owner);
    await expect(
      t.mutation(api.mcpConnections.revokeMcpConnection, { connectionId: String(grant._id) }),
    ).resolves.toEqual({ ok: false, error: "connection_not_found" });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(grant._id))?.status).toBe("active");
    });
  });

  it("revokes Convex first, provides retryable cleanup, and completes idempotently", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada Lovelace",
        onboarded: true,
      }),
    );
    const grant = await makeActiveGrant(t, ada.userId, ada.personalCircleId);

    signInAs(ada.owner);
    const revoked = await t.mutation(api.mcpConnections.revokeMcpConnection, {
      connectionId: String(grant._id),
    });
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) {
      throw new Error(revoked.error);
    }
    expect(revoked.value.cleanupToken).toBeTruthy();
    const cleanupToken = revoked.value.cleanupToken;
    if (!cleanupToken) {
      throw new Error("missing cleanup token");
    }
    expect(await verifyMcpRevocation(cleanupToken, "test-mcp-worker-secret")).toMatchObject({
      grantId: String(grant._id),
      principalId: grant.principalId,
      workerGrantId: "worker-grant-opaque",
    });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(grant._id))?.status).toBe("revoked");
    });

    const completed = await t.mutation(internal.mcpApproval.completeRevocationFromWorker, {
      grantId: String(grant._id),
      principalId: grant.principalId,
      workerGrantId: "worker-grant-opaque",
    });
    expect(completed).toEqual({ ok: true });

    const repeated = await t.mutation(api.mcpConnections.revokeMcpConnection, {
      connectionId: String(grant._id),
    });
    expect(repeated).toEqual({ ok: true, value: { cleanupToken: null } });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(grant._id))?.workerCleanupStatus).toBe("completed");
    });
  });

  it("keeps cleanup pending when no Worker secret is configured", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada Lovelace",
        onboarded: true,
      }),
    );
    const grant = await makeActiveGrant(t, ada.userId, ada.personalCircleId);
    vi.stubEnv("MCP_WORKER_HMAC_SECRET", "");

    signInAs(ada.owner);
    const result = await t.mutation(api.mcpConnections.revokeMcpConnection, {
      connectionId: String(grant._id),
    });
    expect(result).toEqual({ ok: true, value: { cleanupToken: null } });
    await t.run(async (ctx) => {
      const revoked = await ctx.db.get(grant._id);
      expect(revoked?.status).toBe("revoked");
      expect(revoked?.workerCleanupStatus).toBe("pending_revoke");
    });
  });
});
