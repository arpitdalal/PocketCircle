import {
  MCP_RESOURCE_URI,
  type McpHandoffPayload,
  MUTATION_ERRORS,
  mutationErrorData,
  signMcpHandoff,
} from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seedOwnedCircle, seedPersonalCircleOwner } from "../test/seed.js";
import { api } from "./_generated/api.js";
import schema from "./schema.js";

const { mockCurrentUser } = vi.hoisted(() => ({ mockCurrentUser: vi.fn() }));
vi.mock("./auth.js", () => ({
  getCurrentUserOrNull: mockCurrentUser,
  requireCurrentUser: async (ctx: unknown) => {
    const user = await mockCurrentUser(ctx);
    if (!user) {
      throw new Error("Not authenticated");
    }
    return user;
  },
}));

const modules = import.meta.glob("./**/*.ts");
const SECRET = "test-mcp-worker-secret";
const READ_WRITE = ["pocketcircle:read", "pocketcircle:write"] as const;

function handoffPayload(overrides: Partial<McpHandoffPayload> = {}) {
  const now = Date.now();
  return {
    v: 1 as const,
    handoffId: "handoff-1",
    clientId: "https://client.example/client.json",
    clientKind: "cimd" as const,
    redirectUri: "https://client.example/callback",
    resource: MCP_RESOURCE_URI,
    scopes: READ_WRITE,
    clientName: "Example Client",
    clientUri: "https://client.example",
    logoUri: "https://client.example/logo.png",
    iat: now,
    exp: now + 60_000,
    ...overrides,
  } satisfies McpHandoffPayload;
}

beforeEach(() => {
  mockCurrentUser.mockReset();
  vi.stubEnv("MCP_WORKER_HMAC_SECRET", SECRET);
  vi.stubEnv("MCP_WORKER_HMAC_SECRET_PREVIOUS", "");
});

describe("parseMcpHandoff", () => {
  it("returns the safe display fields for a valid handoff", async () => {
    const t = convexTest(schema, modules);
    const payload = handoffPayload();
    const handoff = await signMcpHandoff(payload, SECRET);

    expect(await t.query(api.mcpConsent.parseMcpHandoff, { handoff })).toEqual({
      handoffId: payload.handoffId,
      clientId: payload.clientId,
      clientName: payload.clientName,
      clientUri: payload.clientUri,
      logoUri: payload.logoUri,
      redirectUri: payload.redirectUri,
      resource: payload.resource,
      scopes: payload.scopes,
      refreshDurationLabel: "30 days",
    });
  });

  it("returns null for an expired handoff", async () => {
    const t = convexTest(schema, modules);
    const handoff = await signMcpHandoff(handoffPayload({ exp: Date.now() - 1 }), SECRET);
    expect(await t.query(api.mcpConsent.parseMcpHandoff, { handoff })).toBeNull();
  });

  it("returns null for a wrong-secret signature", async () => {
    const t = convexTest(schema, modules);
    const handoff = await signMcpHandoff(handoffPayload(), "wrong-secret");
    expect(await t.query(api.mcpConsent.parseMcpHandoff, { handoff })).toBeNull();
  });

  it("accepts a handoff signed by the previous rotation secret", async () => {
    const t = convexTest(schema, modules);
    const oldSecret = "previous-worker-secret";
    const payload = handoffPayload();
    const handoff = await signMcpHandoff(payload, oldSecret);
    vi.stubEnv("MCP_WORKER_HMAC_SECRET_PREVIOUS", oldSecret);

    expect(await t.query(api.mcpConsent.parseMcpHandoff, { handoff })).toMatchObject({
      handoffId: payload.handoffId,
      clientId: payload.clientId,
    });
  });

  it("returns null for a malformed token", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.mcpConsent.parseMcpHandoff, { handoff: "not-a-token" })).toBeNull();
  });

  it("fails closed when MCP_WORKER_HMAC_SECRET is unset", async () => {
    const t = convexTest(schema, modules);
    const handoff = await signMcpHandoff(handoffPayload(), SECRET);
    vi.stubEnv("MCP_WORKER_HMAC_SECRET", "");
    expect(await t.query(api.mcpConsent.parseMcpHandoff, { handoff })).toBeNull();
  });
});

describe("approveMcpAuthorization", () => {
  it("creates a pending grant and a redeemable, single-use approval token", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada Lovelace",
        onboarded: true,
      }),
    );
    mockCurrentUser.mockResolvedValue(ada.owner);
    const payload = handoffPayload();
    const handoff = await signMcpHandoff(payload, SECRET);

    const { approvalToken } = await t.mutation(api.mcpConsent.approveMcpAuthorization, {
      handoff,
      selectedCircleIds: [ada.personalCircleId],
      grantedScopes: [...READ_WRITE],
    });
    expect(approvalToken.length).toBeGreaterThan(20);

    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query("mcpGrants")
        .withIndex("by_user", (q) => q.eq("userId", ada.userId))
        .unique();
      expect(grant).toMatchObject({
        status: "pending",
        clientId: payload.clientId,
        clientKind: payload.clientKind,
        redirectUri: payload.redirectUri,
        scopes: READ_WRITE,
        allowedCircleIds: [ada.personalCircleId],
      });
      if (!grant) {
        throw new Error("expected pending grant");
      }

      const approval = await ctx.db
        .query("mcpApprovalTokens")
        .withIndex("by_grant", (q) => q.eq("grantId", grant._id))
        .unique();
      expect(approval).toMatchObject({
        handoffId: payload.handoffId,
        grantId: grant._id,
        userId: ada.userId,
        principalId: grant.principalId,
        clientId: payload.clientId,
        redirectUri: payload.redirectUri,
        resource: payload.resource,
        scopes: READ_WRITE,
        allowedCircleIds: [ada.personalCircleId],
      });
      expect(approval?.consumedAt).toBeUndefined();
      expect(approval?.tokenHash).not.toBe(approvalToken);
    });
  });

  it("allows narrowing granted scopes below the handoff's requested scopes", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    mockCurrentUser.mockResolvedValue(ada.owner);
    const handoff = await signMcpHandoff(handoffPayload(), SECRET);

    await t.mutation(api.mcpConsent.approveMcpAuthorization, {
      handoff,
      selectedCircleIds: [ada.personalCircleId],
      grantedScopes: ["pocketcircle:read"],
    });

    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query("mcpGrants")
        .withIndex("by_user", (q) => q.eq("userId", ada.userId))
        .unique();
      expect(grant?.scopes).toEqual(["pocketcircle:read"]);
    });
  });

  it("rejects granted scopes the handoff never requested (no broadening)", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    mockCurrentUser.mockResolvedValue(ada.owner);
    const handoff = await signMcpHandoff(handoffPayload({ scopes: ["pocketcircle:read"] }), SECRET);

    await expect(
      t.mutation(api.mcpConsent.approveMcpAuthorization, {
        handoff,
        selectedCircleIds: [ada.personalCircleId],
        grantedScopes: [...READ_WRITE],
      }),
    ).rejects.toMatchObject({ data: mutationErrorData(MUTATION_ERRORS.mcpScopesInvalid) });

    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query("mcpGrants")
        .withIndex("by_user", (q) => q.eq("userId", ada.userId))
        .unique();
      expect(grant).toBeNull();
    });
  });

  it("rejects an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    mockCurrentUser.mockResolvedValue(null);
    const handoff = await signMcpHandoff(handoffPayload(), SECRET);

    await expect(
      t.mutation(api.mcpConsent.approveMcpAuthorization, {
        handoff,
        selectedCircleIds: [],
        grantedScopes: ["pocketcircle:read"],
      }),
    ).rejects.toThrow("Not authenticated");
  });

  it("rejects a User who hasn't completed onboarding", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    mockCurrentUser.mockResolvedValue(ada.owner);
    const handoff = await signMcpHandoff(handoffPayload(), SECRET);

    await expect(
      t.mutation(api.mcpConsent.approveMcpAuthorization, {
        handoff,
        selectedCircleIds: [ada.personalCircleId],
        grantedScopes: ["pocketcircle:read"],
      }),
    ).rejects.toMatchObject({ data: mutationErrorData(MUTATION_ERRORS.mcpOnboardingRequired) });
  });

  it.each([
    ["an expired handoff", { exp: Date.now() - 1 }],
    ["a handoff signed with the wrong secret", undefined],
  ] as const)("rejects %s", async (_label, overrides) => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    mockCurrentUser.mockResolvedValue(ada.owner);
    const handoff = overrides
      ? await signMcpHandoff(handoffPayload(overrides), SECRET)
      : await signMcpHandoff(handoffPayload(), "wrong-secret");

    await expect(
      t.mutation(api.mcpConsent.approveMcpAuthorization, {
        handoff,
        selectedCircleIds: [ada.personalCircleId],
        grantedScopes: ["pocketcircle:read"],
      }),
    ).rejects.toMatchObject({ data: mutationErrorData(MUTATION_ERRORS.mcpHandoffInvalid) });
  });

  it("rejects Circles the User can't access", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    const grace = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "grace@example.com",
        displayName: "Grace",
        onboarded: true,
      }),
    );
    mockCurrentUser.mockResolvedValue(ada.owner);
    const handoff = await signMcpHandoff(handoffPayload(), SECRET);

    await expect(
      t.mutation(api.mcpConsent.approveMcpAuthorization, {
        handoff,
        selectedCircleIds: [grace.personalCircleId],
        grantedScopes: ["pocketcircle:read"],
      }),
    ).rejects.toMatchObject({ data: mutationErrorData(MUTATION_ERRORS.mcpCirclesInvalid) });
  });

  it("scopes the approval token to only the selected Circles, not every Circle the User can access", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    const regular = await t.run((ctx) =>
      seedOwnedCircle(ctx, ada.owner, { name: "Shared Trip", setupCompletedAt: Date.now() }),
    );
    mockCurrentUser.mockResolvedValue(ada.owner);
    const handoff = await signMcpHandoff(handoffPayload(), SECRET);

    await t.mutation(api.mcpConsent.approveMcpAuthorization, {
      handoff,
      selectedCircleIds: [ada.personalCircleId],
      grantedScopes: [...READ_WRITE],
    });

    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query("mcpGrants")
        .withIndex("by_user", (q) => q.eq("userId", ada.userId))
        .unique();
      expect(grant?.allowedCircleIds).toEqual([ada.personalCircleId]);
      expect(grant?.allowedCircleIds).not.toContain(regular.circleId);
    });
  });
});
