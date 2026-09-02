import {
  buildRef,
  LIMITS,
  MAX_AMOUNT_MINOR,
  MCP_APPROVAL_TTL_MS,
  MCP_IMAGE_MAX_LENGTH,
  MCP_PENDING_ACTIVATION_TTL_MS,
  MCP_PENDING_GRANT_TTL_MS,
  MCP_RESOURCE_URI,
  MCP_WORKER_ASSERTION_TTL_MS,
  type McpApprovalPayload,
  type McpReadOperation,
  type McpWorkerAssertionPayload,
  type McpWriteOperation,
  parseMcpWorkerJwks,
  parseMcpWorkerPrivateJwk,
  sha256Hex,
  signMcpWorkerAssertion,
} from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActiveMcpGrant } from "../test/mcp.js";
import { mutateAndDrain } from "../test/mutateAndDrain.js";
import { listNotificationsForUser } from "../test/notifications.js";
import {
  addMember,
  makeCategory,
  searchTransactionPage,
  seedOwnedCircle,
  seedOwnedFixture,
  seedPersonalCircleOwner,
  seedTransaction,
  seedTransactionsBulk,
} from "../test/seed.js";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { categoryEntity, recordEvent } from "./history.js";
import { mintMcpApprovalToken } from "./mcpApprovalToken.js";
import { activateMcpGrant, createPendingMcpGrant } from "./mcpGrant.js";
import { generateOpaqueToken } from "./opaqueToken.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");
const SECRET = "test-mcp-worker-secret";
const PRIVATE_JWK_JSON =
  '{"key_ops":["sign"],"ext":true,"kty":"EC","x":"pUT8Qgi_S3CzQeEpsVsOpOWQtHQffFeyQnrDn0Ez_hM","y":"ZJUnZqOxoZZmmnrivG1fFpw7BfeHBEfGGoVA2Y0Q7Vo","crv":"P-256","d":"HQgOJVhMah1F2_TIH_2T3tSXYMUxMCYx_0trUiMrpVI","kid":"test-current","alg":"ES256"}';
const PUBLIC_JWKS_JSON =
  '{"keys":[{"key_ops":["verify"],"ext":true,"kty":"EC","x":"pUT8Qgi_S3CzQeEpsVsOpOWQtHQffFeyQnrDn0Ez_hM","y":"ZJUnZqOxoZZmmnrivG1fFpw7BfeHBEfGGoVA2Y0Q7Vo","crv":"P-256","kid":"test-current","alg":"ES256"}]}';
const OTHER_PRIVATE_JWK_JSON =
  '{"key_ops":["sign"],"ext":true,"kty":"EC","x":"mTXikdKU_DzF10Is9wCtBKJ1e025uEd33NUAcZB5Yms","y":"UeeNalKrnJ4upxgbI2KJjLpyaL_-u-lCcCyd7mB953A","crv":"P-256","d":"ZfNAWUaB-1BOEqcv8mmH4zTsX-GKMNxOfdrrOCOGotU","kid":"test-other","alg":"ES256"}';
const OTHER_PUBLIC_JWKS_JSON =
  '{"keys":[{"key_ops":["verify"],"ext":true,"kty":"EC","x":"mTXikdKU_DzF10Is9wCtBKJ1e025uEd33NUAcZB5Yms","y":"UeeNalKrnJ4upxgbI2KJjLpyaL_-u-lCcCyd7mB953A","crv":"P-256","kid":"test-other","alg":"ES256"}]}';
const READ_WRITE = ["pocketcircle:read", "pocketcircle:write"];
const CLIENT_ID = "https://client.example/client.json";
const REDIRECT_URI = "https://client.example/callback";

const { mockCurrentUser } = vi.hoisted(() => ({ mockCurrentUser: vi.fn() }));
vi.mock("./auth.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getCurrentUserOrNull: mockCurrentUser,
    requireCurrentUser: async (ctx: unknown) => {
      const user = await mockCurrentUser(ctx);
      if (!user) {
        throw new Error("Not authenticated");
      }
      return user;
    },
  };
});

beforeEach(() => {
  mockCurrentUser.mockReset();
  vi.stubEnv("MCP_WORKER_HMAC_SECRET", SECRET);
  vi.stubEnv("MCP_WORKER_HMAC_SECRET_PREVIOUS", "");
  vi.stubEnv("MCP_WORKER_VERIFYING_JWKS", PUBLIC_JWKS_JSON);
});

async function executeMcpRead(
  t: ReturnType<typeof convexTest>,
  grantId: Id<"mcpGrants">,
  operation: McpReadOperation,
  effectiveScopes: string[] = ["pocketcircle:read"],
) {
  return t.query(internal.mcpApproval.executeMcpReadOperation, {
    grantId,
    effectiveScopes,
    operation,
  });
}

async function executeMcpWrite(
  t: ReturnType<typeof convexTest>,
  grantId: Id<"mcpGrants">,
  operation: McpWriteOperation,
  effectiveScopes: string[] = READ_WRITE,
) {
  return t.mutation(internal.mcpApproval.executeMcpWriteOperation, {
    grantId,
    effectiveScopes,
    operation,
  });
}

async function seedMcpWriteFixture(
  t: ReturnType<typeof convexTest>,
  options?: { includeMemberGrant?: boolean; ownerEmail?: string },
) {
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
    clientId: CLIENT_ID,
    clientKind: "static",
    redirectUri: REDIRECT_URI,
  });
  const circleRef = buildRef("Trip", f.circleId);
  if (!options?.includeMemberGrant) {
    return { owner, f, member, grant, circleRef };
  }
  const memberGrant = await createActiveMcpGrant(t, {
    userId: member.user._id,
    circleIds: [f.circleId],
    scopes: READ_WRITE,
    clientId: `${CLIENT_ID}/member`,
    clientKind: "static",
    redirectUri: REDIRECT_URI,
  });
  return { owner, f, member, grant, memberGrant, circleRef };
}

async function seedUpdateFixture(
  t: ReturnType<typeof convexTest>,
  options?: { status?: "active" | "archived" },
) {
  const owner = await t.run((ctx) =>
    seedPersonalCircleOwner(ctx, { email: "updater@example.com", displayName: "Updater Owner" }),
  );
  const f = await t.run((ctx) =>
    seedOwnedFixture(ctx, owner.owner, { name: "Trip", currency: "USD" }),
  );
  const member = await t.run((ctx) =>
    addMember(ctx, f.circleId, "maya@example.com", "Maya Member"),
  );
  const txnId = await t.run((ctx) =>
    seedTransaction(ctx, f, {
      title: "Team lunch",
      note: "Sushi",
      amountMinorUnits: 2_500,
      date: "2026-06-01",
      categoryIds: [f.groceriesId],
      ...(options?.status === "archived" ? { status: "archived" as const } : {}),
    }),
  );
  const grant = await createActiveMcpGrant(t, {
    userId: owner.userId,
    circleIds: [f.circleId],
    scopes: READ_WRITE,
    clientId: CLIENT_ID,
    clientKind: "static",
    redirectUri: REDIRECT_URI,
  });
  return {
    owner,
    f,
    member,
    txnId,
    grant,
    circleRef: buildRef("Trip", f.circleId),
    transactionRef: buildRef("Team lunch", txnId),
    groceriesRef: buildRef("Groceries", f.groceriesId),
    diningRef: buildRef("Dining", f.diningId),
    salaryRef: buildRef("Salary", f.salaryId),
  };
}

function signingKey(value: string = PRIVATE_JWK_JSON) {
  const key = parseMcpWorkerPrivateJwk(value);
  if (!key) throw new Error("invalid test private JWK");
  return key;
}

/** Seeds a pending grant (real `createPendingMcpGrant`, no auth needed) + its approval token row. */
async function seedApprovalToken(
  t: ReturnType<typeof convexTest>,
  args: {
    userId: Id<"users">;
    circleIds: Id<"circles">[];
    scopes?: readonly string[];
    expiresAt?: number;
    consumedAt?: number;
  },
) {
  return await t.run(async (ctx) => {
    const pending = await createPendingMcpGrant(ctx, {
      userId: args.userId,
      clientId: CLIENT_ID,
      clientKind: "cimd",
      redirectUri: REDIRECT_URI,
      scopes: args.scopes ?? READ_WRITE,
      allowedCircleIds: args.circleIds,
    });
    if (!pending.ok) {
      throw new Error(`seed failed: ${pending.error}`);
    }
    const grant = pending.value;
    const now = Date.now();
    const expiresAt = args.expiresAt ?? now + MCP_APPROVAL_TTL_MS;
    const payload: McpApprovalPayload = {
      jti: generateOpaqueToken(),
      handoffId: "handoff-1",
      grantId: grant._id,
      userId: grant.userId,
      principalId: grant.principalId,
      clientId: grant.clientId,
      redirectUri: grant.redirectUri,
      resource: MCP_RESOURCE_URI,
      scopes: grant.scopes,
      allowedCircleIds: grant.allowedCircleIds,
      iat: now,
      exp: expiresAt,
    };
    const { token, tokenHash } = await mintMcpApprovalToken(payload, SECRET);
    await ctx.db.insert("mcpApprovalTokens", {
      tokenHash,
      handoffId: "handoff-1",
      grantId: grant._id,
      userId: grant.userId,
      principalId: grant.principalId,
      clientId: grant.clientId,
      redirectUri: grant.redirectUri,
      resource: MCP_RESOURCE_URI,
      scopes: grant.scopes,
      allowedCircleIds: grant.allowedCircleIds,
      expiresAt,
      createdAt: now,
      consumedAt: args.consumedAt,
    });
    return { token, grant, payload };
  });
}

function redeemApproval(
  t: ReturnType<typeof convexTest>,
  token: string,
  claimId = "claim-1",
  handoffId = "handoff-1",
) {
  return t.mutation(internal.mcpApproval.redeemApprovalToken, { token, claimId, handoffId });
}

describe("redeemApprovalToken", () => {
  it("consumes atomically and returns the grant identifiers", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const { token, grant } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
    });

    const result = await redeemApproval(t, token);
    expect(result).toEqual({
      ok: true,
      value: {
        grantId: grant._id,
        principalId: grant.principalId,
        clientId: grant.clientId,
        redirectUri: grant.redirectUri,
        resource: MCP_RESOURCE_URI,
        scopes: grant.scopes,
        allowedCircleIds: grant.allowedCircleIds,
        handoffId: "handoff-1",
      },
    });
  });

  it("returns the same grant when the same completion claim retries", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const { token } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
    });

    const first = await redeemApproval(t, token);
    expect(await redeemApproval(t, token)).toEqual(first);
  });

  it("extends pending activation through completion recovery and code exchange", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const { token, grant } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
    });
    const claimedAt = Date.now();

    expect(await redeemApproval(t, token)).toMatchObject({ ok: true });
    await t.run(async (ctx) => {
      const claimed = await ctx.db.get(grant._id);
      expect(claimed?.activationExpiresAt).toBeGreaterThanOrEqual(
        claimedAt + MCP_PENDING_ACTIVATION_TTL_MS,
      );
      const delayed = await activateMcpGrant(ctx, {
        grantId: grant._id,
        workerGrantId: "worker-delayed",
        principalId: grant.principalId,
        now: claimedAt + MCP_PENDING_GRANT_TTL_MS + 1,
      });
      expect(delayed.ok).toBe(true);
    });
  });

  it("rejects a second completion claim for the same token", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const { token } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
    });

    const [first, second] = await Promise.all([
      redeemApproval(t, token, "claim-1"),
      redeemApproval(t, token, "claim-2"),
    ]);
    const outcomes = [first, second];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    expect(outcomes.filter((r) => !r.ok)).toEqual([{ ok: false, error: "consumed" }]);
  });

  it("rejects a token that doesn't exist", async () => {
    const t = convexTest(schema, modules);
    expect(await redeemApproval(t, "unknown-token")).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("rejects an expired token", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const { token } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
      expiresAt: Date.now() - 1,
    });
    expect(await redeemApproval(t, token)).toEqual({
      ok: false,
      error: "expired",
    });
  });

  it("rejects a forged token signed with a different secret", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const { payload } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
    });
    const { signMcpApproval } = await import("@pocketcircle/domain");
    const forgedToken = await signMcpApproval(payload, "forged-secret-different-key");
    expect(await redeemApproval(t, forgedToken)).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("rejects an approval token when stored claims mismatch", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const { token } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
    });
    // Tamper the stored approval token's redirectUri
    await t.run(async (ctx) => {
      const stored = await ctx.db.query("mcpApprovalTokens").first();
      if (stored) {
        await ctx.db.patch(stored._id, { redirectUri: "https://tampered.example/cb" });
      }
    });
    expect(await redeemApproval(t, token)).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("accepts an approval signed by the previous rotation secret", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const oldSecret = "previous-worker-secret";
    const seeded = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
    });
    const { token, tokenHash } = await mintMcpApprovalToken(seeded.payload, oldSecret);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("mcpApprovalTokens").first();
      if (!row) {
        throw new Error("expected approval row");
      }
      await ctx.db.patch(row._id, { tokenHash });
    });
    vi.stubEnv("MCP_WORKER_HMAC_SECRET_PREVIOUS", oldSecret);

    expect(await redeemApproval(t, token)).toMatchObject({ ok: true });
  });
});

describe("MCP Circle, Member, and Circle History reads", () => {
  it("returns safe Circle data and active Members, with historical widening", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "owner@example.com",
        displayName: "Olive Owner",
        onboarded: true,
      }),
    );
    const circle = await t.run((ctx) =>
      seedOwnedCircle(ctx, owner.owner, {
        name: "Summer Trip",
        currency: "EUR",
        archived: true,
        setupCompletedAt: Date.now(),
      }),
    );
    const deletedBeforeMaya = await t.run((ctx) =>
      addMember(ctx, circle.circleId, "deleted@example.com", "Deleted Member"),
    );
    await t.run((ctx) => ctx.db.delete(deletedBeforeMaya.user._id));
    const maya = await t.run((ctx) =>
      addMember(ctx, circle.circleId, "maya@example.com", "Maya Member"),
    );
    await t.run((ctx) =>
      ctx.db.patch(maya.memberId, { image: "x".repeat(MCP_IMAGE_MAX_LENGTH + 1) }),
    );
    const nora = await t.run((ctx) =>
      addMember(ctx, circle.circleId, "nora@example.com", "Nora Member"),
    );
    const removed = await t.run((ctx) =>
      addMember(ctx, circle.circleId, "bo@example.com", "Bo Removed", "removed"),
    );
    const grant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [circle.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT_ID,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });

    const safeCircle = await executeMcpRead(t, grant._id, {
      kind: "get_circle",
      circleRef: buildRef("Summer Trip", circle.circleId),
    });
    expect(safeCircle).toMatchObject({
      ok: true,
      value: {
        id: circle.circleId,
        ref: buildRef("Summer Trip", circle.circleId),
        name: "Summer Trip",
        currency: "EUR",
        status: "archived",
        setupComplete: true,
        isOwner: true,
      },
    });

    const active = await executeMcpRead(t, grant._id, {
      kind: "list_members",
      circleRef: String(circle.circleId),
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(active).toMatchObject({ ok: true });
    if (!active.ok || !("value" in active)) {
      throw new Error("expected active member page");
    }
    expect(active.value.page.map((member) => member.displayName)).toEqual(["Olive Owner"]);
    expect(active.value.isDone).toBe(false);

    const activeSecondPage = await executeMcpRead(t, grant._id, {
      kind: "list_members",
      circleRef: String(circle.circleId),
      paginationOpts: { numItems: 1, cursor: active.value.continueCursor },
    });
    expect(activeSecondPage).toMatchObject({ ok: true });
    if (!activeSecondPage.ok || !("value" in activeSecondPage)) {
      throw new Error("expected second active member page");
    }
    expect(activeSecondPage.value.page.map((member) => member.displayName)).toEqual([
      "Maya Member",
    ]);
    expect(activeSecondPage.value.page[0]?.image).toBeNull();
    const activeThirdPage = await executeMcpRead(t, grant._id, {
      kind: "list_members",
      circleRef: String(circle.circleId),
      paginationOpts: { numItems: 1, cursor: activeSecondPage.value.continueCursor },
    });
    expect(activeThirdPage).toMatchObject({ ok: true });
    if (!activeThirdPage.ok || !("value" in activeThirdPage)) {
      throw new Error("expected third active member page");
    }
    expect(activeThirdPage.value.page.map((member) => member.displayName)).toEqual(["Nora Member"]);
    expect(JSON.stringify(active.value)).not.toContain(owner.owner.email);
    expect(JSON.stringify(active.value)).not.toContain("userId");

    const historical = await executeMcpRead(t, grant._id, {
      kind: "list_members",
      circleRef: String(circle.circleId),
      includeHistorical: true,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(historical).toMatchObject({ ok: true });
    if (!historical.ok || !("value" in historical)) {
      throw new Error("expected historical member page");
    }
    expect(historical.value.page.map((member) => member.displayName)).toEqual([
      "Olive Owner",
      "Deleted Member",
      "Maya Member",
      "Nora Member",
      "Bo Removed",
    ]);
    expect(historical.value.page.find((member) => member.id === removed.memberId)?.status).toBe(
      "removed",
    );
    expect(maya.memberId).not.toBe(removed.memberId);
    expect(nora.memberId).not.toBe(removed.memberId);

    await t.run((ctx) => ctx.db.delete(maya.user._id));
    const deleted = await executeMcpRead(t, grant._id, {
      kind: "list_members",
      circleRef: String(circle.circleId),
      includeHistorical: true,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(deleted).toMatchObject({ ok: true });
    if (!deleted.ok || !("value" in deleted)) {
      throw new Error("expected deleted member page");
    }
    expect(deleted.value.page.find((member) => member.id === maya.memberId)?.status).toBe(
      "deleted",
    );
  });

  it("keeps active member cursors valid across ownership transfer", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "owner@example.com",
        displayName: "Olive Owner",
        onboarded: true,
      }),
    );
    const circle = await t.run((ctx) =>
      seedOwnedCircle(ctx, owner.owner, { name: "Transfer Trip", setupCompletedAt: Date.now() }),
    );
    const nextOwner = await t.run((ctx) =>
      addMember(ctx, circle.circleId, "next-owner@example.com", "Next Owner"),
    );
    const remaining = await t.run((ctx) =>
      addMember(ctx, circle.circleId, "remaining@example.com", "Remaining Member"),
    );
    const later = await t.run((ctx) =>
      addMember(ctx, circle.circleId, "later@example.com", "Later Member"),
    );
    const grant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [circle.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT_ID,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });

    const firstPage = await executeMcpRead(t, grant._id, {
      kind: "list_members",
      circleRef: String(circle.circleId),
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(firstPage).toMatchObject({ ok: true });
    if (!firstPage.ok || !("value" in firstPage)) {
      throw new Error("expected first active member page");
    }
    expect(firstPage.value.page.map((member) => member.displayName)).toEqual(["Olive Owner"]);

    const historicalFirstPage = await executeMcpRead(t, grant._id, {
      kind: "list_members",
      circleRef: String(circle.circleId),
      includeHistorical: true,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(historicalFirstPage).toMatchObject({ ok: true });
    if (!historicalFirstPage.ok || !("value" in historicalFirstPage)) {
      throw new Error("expected first historical member page");
    }
    expect(historicalFirstPage.value.page.map((member) => member.displayName)).toEqual([
      "Olive Owner",
      "Next Owner",
    ]);

    mockCurrentUser.mockResolvedValue(owner.owner);
    await mutateAndDrain(t, () =>
      t.mutation(api.members.transferOwnership, {
        circleId: circle.circleId,
        toMemberId: nextOwner.memberId,
      }),
    );

    const secondPage = await executeMcpRead(t, grant._id, {
      kind: "list_members",
      circleRef: String(circle.circleId),
      paginationOpts: { numItems: 1, cursor: firstPage.value.continueCursor },
    });
    expect(secondPage).toMatchObject({ ok: true });
    if (!secondPage.ok || !("value" in secondPage)) {
      throw new Error("expected second active member page");
    }
    expect(secondPage.value.page.map((member) => member.displayName)).toEqual(["Next Owner"]);

    const historicalSecondPage = await executeMcpRead(t, grant._id, {
      kind: "list_members",
      circleRef: String(circle.circleId),
      includeHistorical: true,
      paginationOpts: { numItems: 1, cursor: historicalFirstPage.value.continueCursor },
    });
    expect(historicalSecondPage).toMatchObject({ ok: true });
    if (!historicalSecondPage.ok || !("value" in historicalSecondPage)) {
      throw new Error("expected second historical member page");
    }
    expect(historicalSecondPage.value.page.map((member) => member.displayName)).toEqual([
      "Remaining Member",
    ]);

    const thirdPage = await executeMcpRead(t, grant._id, {
      kind: "list_members",
      circleRef: String(circle.circleId),
      paginationOpts: { numItems: 1, cursor: secondPage.value.continueCursor },
    });
    expect(thirdPage).toMatchObject({ ok: true });
    if (!thirdPage.ok || !("value" in thirdPage)) {
      throw new Error("expected third active member page");
    }
    expect(thirdPage.value.page.map((member) => member.displayName)).toEqual(["Remaining Member"]);
    expect(remaining.memberId).not.toBe(nextOwner.memberId);

    const ownerAndMemberPage = await executeMcpRead(t, grant._id, {
      kind: "list_members",
      circleRef: String(circle.circleId),
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(ownerAndMemberPage).toMatchObject({ ok: true });
    if (!ownerAndMemberPage.ok || !("value" in ownerAndMemberPage)) {
      throw new Error("expected owner and member page");
    }
    expect(ownerAndMemberPage.value.page.map((member) => member.displayName)).toEqual([
      "Next Owner",
      "Olive Owner",
    ]);

    mockCurrentUser.mockResolvedValue(nextOwner.user);
    await mutateAndDrain(t, () =>
      t.mutation(api.members.transferOwnership, {
        circleId: circle.circleId,
        toMemberId: remaining.memberId,
      }),
    );

    const afterNewOwner = await executeMcpRead(t, grant._id, {
      kind: "list_members",
      circleRef: String(circle.circleId),
      paginationOpts: { numItems: 1, cursor: ownerAndMemberPage.value.continueCursor },
    });
    expect(afterNewOwner).toMatchObject({ ok: true });
    if (!afterNewOwner.ok || !("value" in afterNewOwner)) {
      throw new Error("expected page after new owner");
    }
    expect(afterNewOwner.value.page.map((member) => member.displayName)).toEqual([
      "Remaining Member",
    ]);

    const afterNewOwnerContinuation = await executeMcpRead(t, grant._id, {
      kind: "list_members",
      circleRef: String(circle.circleId),
      paginationOpts: { numItems: 1, cursor: afterNewOwner.value.continueCursor },
    });
    expect(afterNewOwnerContinuation).toMatchObject({ ok: true });
    if (!afterNewOwnerContinuation.ok || !("value" in afterNewOwnerContinuation)) {
      throw new Error("expected continuation after new owner");
    }
    expect(afterNewOwnerContinuation.value.page.map((member) => member.displayName)).toEqual([
      "Later Member",
    ]);
    expect(later.memberId).not.toBe(remaining.memberId);
  });

  it("keeps Circle History paginated and redacts Invitation email for non-Owners", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "owner@example.com",
        displayName: "Olive Owner",
        onboarded: true,
      }),
    );
    const circle = await t.run((ctx) =>
      seedOwnedCircle(ctx, owner.owner, { name: "History Trip", setupCompletedAt: Date.now() }),
    );
    const maya = await t.run((ctx) =>
      addMember(ctx, circle.circleId, "maya@example.com", "Maya Member"),
    );
    await t.run((ctx) =>
      ctx.db.patch(circle.ownerMemberId, { image: "x".repeat(MCP_IMAGE_MAX_LENGTH + 1) }),
    );
    await t.run(async (ctx) => {
      for (const [index, action] of ["created", "member invited", "renamed"].entries()) {
        await ctx.db.insert("histories", {
          entityId: circle.circleId,
          circleId: circle.circleId,
          actorMemberId: circle.ownerMemberId,
          action,
          changes:
            action === "member invited"
              ? [{ field: "email", to: "invitee@example.com" }]
              : [{ field: "name", to: `Value ${index}` }],
          createdAt: Date.now() + index,
        });
      }
    });
    const grant = await createActiveMcpGrant(t, {
      userId: maya.user._id,
      circleIds: [circle.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT_ID,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });

    const first = await executeMcpRead(t, grant._id, {
      kind: "list_circle_history",
      circleRef: buildRef("History Trip", circle.circleId),
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first).toMatchObject({ ok: true });
    if (!first.ok || !("value" in first)) {
      throw new Error("expected history page");
    }
    expect(first.value.page).toHaveLength(2);
    expect(first.value.isDone).toBe(false);
    expect(
      first.value.page.some((event) => event.changes.some((change) => change.field === "email")),
    ).toBe(false);
    expect(JSON.stringify(first.value)).not.toContain("invitee@example.com");

    const second = await executeMcpRead(t, grant._id, {
      kind: "list_circle_history",
      circleRef: String(circle.circleId),
      paginationOpts: { numItems: 2, cursor: first.value.continueCursor },
    });
    expect(second).toMatchObject({ ok: true });
    if (!second.ok || !("value" in second)) {
      throw new Error("expected second history page");
    }
    expect(second.value.page[0]?.id).not.toBe(first.value.page[0]?.id);
    expect(second.value.page[0]?.actor?.displayName).toBe("Olive Owner");
    expect(second.value.page[0]?.actor?.image).toBeNull();
  });

  it("collapses deselected, removed, and malformed Circle references", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "owner@example.com", displayName: "Olive Owner" }),
    );
    const selected = await t.run((ctx) => seedOwnedCircle(ctx, owner.owner, { name: "Selected" }));
    const other = await t.run((ctx) => seedOwnedCircle(ctx, owner.owner, { name: "Other" }));
    const grant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [selected.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT_ID,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });

    const deselected = await executeMcpRead(t, grant._id, {
      kind: "get_circle",
      circleRef: buildRef("Other", other.circleId),
    });
    const malformed = await executeMcpRead(t, grant._id, {
      kind: "get_circle",
      circleRef: "not-a-circle-reference",
    });
    expect(deselected).toMatchObject({ ok: false, error: "circle_inaccessible" });
    expect(malformed).toMatchObject({ ok: false, error: "circle_inaccessible" });

    const scopeDenied = await executeMcpRead(
      t,
      grant._id,
      { kind: "get_circle", circleRef: buildRef("Selected", selected.circleId) },
      [],
    );
    expect(scopeDenied).toMatchObject({ ok: false, error: "insufficient_scope" });

    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", selected.circleId).eq("userId", owner.userId),
        )
        .unique();
      if (!membership) throw new Error("owner membership missing");
      await ctx.db.patch(membership._id, { status: "removed" });
    });
    const removed = await executeMcpRead(t, grant._id, {
      kind: "list_circle_history",
      circleRef: String(selected.circleId),
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(removed).toMatchObject({ ok: false, error: "circle_inaccessible" });

    await t.run((ctx) => ctx.db.patch(grant._id, { status: "revoked", revokedAt: Date.now() }));
    const revoked = await executeMcpRead(t, grant._id, {
      kind: "get_circle",
      circleRef: buildRef("Selected", selected.circleId),
    });
    expect(revoked).toMatchObject({ ok: false, error: "grant_unavailable" });
  });
});

describe("MCP Transaction search and inspect reads", () => {
  it("searches with defaults, filters, pagination, archived rows, and omits internal ids", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "owner@example.com", displayName: "Olive Owner" }),
    );
    const f = await t.run((ctx) =>
      seedOwnedFixture(ctx, owner.owner, {
        name: "Trip",
        currency: "EUR",
        archived: true,
      }),
    );
    const maya = await t.run((ctx) =>
      addMember(ctx, f.circleId, "maya@example.com", "Maya Member"),
    );
    const removed = await t.run(async (ctx) => {
      const member = await addMember(ctx, f.circleId, "bo@example.com", "Bo Removed", "removed");
      return member;
    });
    await t.run(async (ctx) => {
      await seedTransaction(ctx, f, {
        title: "May rent",
        date: "2026-05-10",
        amountMinorUnits: 1_000,
      });
      await seedTransaction(ctx, f, {
        title: "June cafe",
        date: "2026-06-10",
        amountMinorUnits: 500,
        paidByMemberId: maya.memberId,
        recordedByMemberId: maya.memberId,
        categoryIds: [f.diningId],
        type: "expense",
      });
      await seedTransaction(ctx, f, {
        title: "Archived rent",
        date: "2026-06-11",
        status: "archived",
        paidByMemberId: removed.memberId,
      });
      await seedTransaction(ctx, f, { title: "Outside month", date: "2026-07-01" });
    });
    const grant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [f.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT_ID,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    const circleRef = buildRef("Trip", f.circleId);

    const activeDefault = await executeMcpRead(t, grant._id, {
      kind: "search_transactions",
      circleRef,
    });
    expect(activeDefault).toMatchObject({ ok: true });
    if (!activeDefault.ok || !("value" in activeDefault)) {
      throw new Error("expected active search");
    }
    expect(activeDefault.value.pagination).toBe("offset");
    if (activeDefault.value.pagination !== "offset") {
      throw new Error("expected offset pagination");
    }
    expect(activeDefault.value.transactions.map((txn) => txn.title)).toEqual([
      "Outside month",
      "June cafe",
      "May rent",
    ]);
    expect(JSON.stringify(activeDefault.value)).not.toMatch(/"id":/);
    for (const txn of activeDefault.value.transactions) {
      expect(txn).not.toHaveProperty("id");
      expect(txn.currency).toBe("EUR");
      for (const category of txn.categories) {
        expect(category).not.toHaveProperty("id");
      }
      expect(txn.recordedBy).not.toHaveProperty("id");
      expect(txn.paidBy).not.toHaveProperty("id");
    }

    const statusAll = await executeMcpRead(t, grant._id, {
      kind: "search_transactions",
      circleRef,
      filters: { status: "all", dateFrom: "2026-06-01", dateTo: "2026-06-30" },
      ...searchTransactionPage(1, 25),
    });
    expect(
      statusAll.ok &&
        statusAll.value.pagination === "offset" &&
        statusAll.value.transactions.map((txn) => txn.title),
    ).toEqual(["Archived rent", "June cafe"]);

    const combined = await executeMcpRead(t, grant._id, {
      kind: "search_transactions",
      circleRef,
      filters: {
        type: "expense",
        status: "active",
        categoryRefs: [buildRef("Dining", f.diningId)],
        paidByMemberIds: [maya.memberId],
        recordedByMemberIds: [maya.memberId],
        amountMin: 400,
        amountMax: 600,
        query: "cafe",
      },
      ...searchTransactionPage(1, 25),
    });
    expect(
      combined.ok &&
        combined.value.pagination === "offset" &&
        combined.value.transactions.map((txn) => txn.title),
    ).toEqual(["June cafe"]);

    const monthCursor = await executeMcpRead(t, grant._id, {
      kind: "search_transactions",
      circleRef,
      filters: { month: "2026-06", status: "all" },
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(monthCursor).toMatchObject({ ok: true });
    if (!monthCursor.ok || monthCursor.value.pagination !== "cursor") {
      throw new Error("expected cursor page");
    }
    expect(monthCursor.value.page).toHaveLength(1);
    expect(monthCursor.value.isDone).toBe(false);

    const monthSecond = await executeMcpRead(t, grant._id, {
      kind: "search_transactions",
      circleRef,
      filters: { month: "2026-06", status: "all" },
      paginationOpts: { numItems: 1, cursor: monthCursor.value.continueCursor },
    });
    expect(
      monthSecond.ok && monthSecond.value.pagination === "cursor" && monthSecond.value.page,
    ).toHaveLength(1);
    if (
      monthCursor.ok &&
      monthCursor.value.pagination === "cursor" &&
      monthSecond.ok &&
      monthSecond.value.pagination === "cursor"
    ) {
      expect(monthSecond.value.page[0]?.ref).not.toBe(monthCursor.value.page[0]?.ref);
    }

    const emptyFilters = await executeMcpRead(t, grant._id, {
      kind: "search_transactions",
      circleRef,
      filters: { categoryRefs: ["not-a-category"] },
      ...searchTransactionPage(1, 25),
    });
    expect(
      emptyFilters.ok &&
        emptyFilters.value.pagination === "offset" &&
        emptyFilters.value.transactions,
    ).toEqual([]);
  });

  it("returns transaction detail, history, removed attribution, and collapses inaccessible refs", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "owner@example.com", displayName: "Olive Owner" }),
    );
    const f = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Selected" }));
    const other = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Other" }));
    const removed = await t.run(async (ctx) => {
      const member = await addMember(ctx, f.circleId, "bo@example.com", "Bo Removed", "removed");
      return member;
    });
    const txnId = await t.run(async (ctx) =>
      seedTransaction(ctx, f, {
        title: "Team lunch",
        note: "Sushi place",
        paidByMemberId: removed.memberId,
      }),
    );
    const grant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [f.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT_ID,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    const circleRef = buildRef("Selected", f.circleId);
    const transactionRef = buildRef("Team lunch", txnId);

    const detail = await executeMcpRead(t, grant._id, {
      kind: "get_transaction",
      circleRef,
      transactionRef,
    });
    expect(detail).toMatchObject({
      ok: true,
      value: {
        ref: transactionRef,
        title: "Team lunch",
        note: "Sushi place",
        currency: "USD",
        paidBy: { displayName: "Bo Removed" },
        canEditFields: true,
        canArchive: true,
        audit: {
          createdBy: { displayName: "Olive Owner" },
        },
      },
    });
    expect(detail.ok && "value" in detail && detail.value).not.toHaveProperty("id");
    if (detail.ok && "value" in detail) {
      expect(JSON.stringify(detail.value.categories)).not.toMatch(/"id":/);
    }

    const history = await executeMcpRead(t, grant._id, {
      kind: "list_transaction_history",
      circleRef,
      transactionRef,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(history).toMatchObject({ ok: true, value: { isDone: true } });

    mockCurrentUser.mockResolvedValue(owner.owner);
    const liveId = await t.mutation(api.transactions.createTransaction, {
      circleId: f.circleId,
      expectedCurrency: "USD",
      type: "expense",
      title: "Weekly shop",
      amountMinorUnits: 1250,
      date: "2026-05-15",
      categoryIds: [f.groceriesId],
    });
    await t.mutation(api.transactions.updateTransaction, {
      transactionId: liveId,
      amountMinorUnits: 9900,
    });
    const liveHistory = await executeMcpRead(t, grant._id, {
      kind: "list_transaction_history",
      circleRef,
      transactionRef: buildRef("Weekly shop", liveId),
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(liveHistory).toMatchObject({ ok: true });
    if (!liveHistory.ok || !("value" in liveHistory)) {
      throw new Error("expected live history");
    }
    expect(liveHistory.value.page.map((event) => event.action)).toEqual(["edited", "created"]);
    const amountChange = liveHistory.value.page[0]?.changes.find(
      (change) => change.field === "amount",
    );
    expect(amountChange?.fromMoney).toEqual({ minorUnits: 1250, currency: "USD" });
    expect(amountChange?.toMoney).toEqual({ minorUnits: 9900, currency: "USD" });

    await t.run(async (ctx) => {
      for (let index = 0; index < 3; index += 1) {
        await ctx.db.insert("histories", {
          entityId: liveId,
          circleId: f.circleId,
          actorMemberId: f.ownerMemberId,
          action: "edited",
          changes: [{ field: "title", to: `Edit ${index}` }],
          createdAt: Date.now() + index,
        });
      }
    });
    const historyFirstPage = await executeMcpRead(t, grant._id, {
      kind: "list_transaction_history",
      circleRef,
      transactionRef: buildRef("Weekly shop", liveId),
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(historyFirstPage).toMatchObject({ ok: true });
    if (!historyFirstPage.ok || !("value" in historyFirstPage)) {
      throw new Error("expected history page");
    }
    expect(historyFirstPage.value.page).toHaveLength(2);
    expect(historyFirstPage.value.isDone).toBe(false);
    const historySecondPage = await executeMcpRead(t, grant._id, {
      kind: "list_transaction_history",
      circleRef,
      transactionRef: buildRef("Weekly shop", liveId),
      paginationOpts: { numItems: 2, cursor: historyFirstPage.value.continueCursor },
    });
    expect(
      historySecondPage.ok && "value" in historySecondPage && historySecondPage.value.page.length,
    ).toBeGreaterThan(0);

    const deselected = await executeMcpRead(t, grant._id, {
      kind: "get_transaction",
      circleRef: buildRef("Other", other.circleId),
      transactionRef,
    });
    const malformed = await executeMcpRead(t, grant._id, {
      kind: "get_transaction",
      circleRef,
      transactionRef: "not-a-transaction",
    });
    expect(deselected).toMatchObject({ ok: false, error: "circle_inaccessible" });
    expect(malformed).toMatchObject({ ok: false, error: "transaction_inaccessible" });

    const emptyHistory = await executeMcpRead(t, grant._id, {
      kind: "list_transaction_history",
      circleRef,
      transactionRef: "missing-ref",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(emptyHistory).toMatchObject({
      ok: true,
      value: { page: [], isDone: true, continueCursor: "" },
    });

    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", f.circleId).eq("userId", owner.userId),
        )
        .unique();
      if (!membership) throw new Error("owner membership missing");
      await ctx.db.patch(membership._id, { status: "removed" });
    });
    const removedMember = await executeMcpRead(t, grant._id, {
      kind: "get_transaction",
      circleRef,
      transactionRef,
    });
    expect(removedMember).toMatchObject({ ok: false, error: "circle_inaccessible" });
  });

  it("covers isolated filters, attribution, ordering, archived detail, deselected search, and count cap", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "owner@example.com", displayName: "Olive Owner" }),
    );
    const f = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Filters" }));
    const other = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Other" }));
    const maya = await t.run((ctx) =>
      addMember(ctx, f.circleId, "maya@example.com", "Maya Member"),
    );
    const deletedMember = await t.run(async (ctx) => {
      const member = await addMember(ctx, f.circleId, "deleted@example.com", "Deleted Member");
      await ctx.db.delete(member.user._id);
      return member;
    });
    const seeded = await t.run(async (ctx) => {
      await seedTransaction(ctx, f, {
        title: "Salary payment",
        type: "income",
        categoryIds: [f.salaryId],
        date: "2026-05-20",
        amountMinorUnits: 500_000,
      });
      await seedTransaction(ctx, f, {
        title: "Unique needle row",
        note: "alpha keyword",
        date: "2026-05-20",
        createdAt: 1,
      });
      await seedTransaction(ctx, f, {
        title: "Same day second",
        date: "2026-05-20",
        createdAt: 2,
      });
      await seedTransaction(ctx, f, {
        title: "Maya recorded",
        recordedByMemberId: maya.memberId,
        paidByMemberId: maya.memberId,
        date: "2026-05-18",
      });
      await seedTransaction(ctx, f, {
        title: "Deleted paid by",
        paidByMemberId: deletedMember.memberId,
        date: "2026-05-17",
      });
      const archivedId = await seedTransaction(ctx, f, {
        title: "Archived detail",
        status: "archived",
        date: "2026-05-16",
      });
      await seedTransactionsBulk(ctx, f, 210, {
        titlePrefix: "cap-row",
        syncSearch: true,
      });
      return { archivedId };
    });
    const grant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [f.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT_ID,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    const circleRef = buildRef("Filters", f.circleId);

    const incomeOnly = await executeMcpRead(t, grant._id, {
      kind: "search_transactions",
      circleRef,
      filters: { type: "income" },
      ...searchTransactionPage(1, 25),
    });
    expect(
      incomeOnly.ok &&
        incomeOnly.value.pagination === "offset" &&
        incomeOnly.value.transactions.map((txn) => txn.title),
    ).toEqual(["Salary payment"]);

    const queryOnly = await executeMcpRead(t, grant._id, {
      kind: "search_transactions",
      circleRef,
      filters: { query: "needle" },
      ...searchTransactionPage(1, 25),
    });
    expect(
      queryOnly.ok &&
        queryOnly.value.pagination === "offset" &&
        queryOnly.value.transactions.map((txn) => txn.title),
    ).toEqual(["Unique needle row"]);

    const recordedByOnly = await executeMcpRead(t, grant._id, {
      kind: "search_transactions",
      circleRef,
      filters: { recordedByMemberIds: [maya.memberId] },
      ...searchTransactionPage(1, 25),
    });
    expect(
      recordedByOnly.ok &&
        recordedByOnly.value.pagination === "offset" &&
        recordedByOnly.value.transactions.map((txn) => txn.title),
    ).toEqual(["Maya recorded"]);

    const dateWindow = await executeMcpRead(t, grant._id, {
      kind: "search_transactions",
      circleRef,
      filters: { dateFrom: "2026-05-20", dateTo: "2026-05-20", status: "all" },
      ...searchTransactionPage(1, 25),
    });
    expect(
      dateWindow.ok &&
        dateWindow.value.pagination === "offset" &&
        dateWindow.value.transactions.map((txn) => txn.title),
    ).toEqual(["Same day second", "Unique needle row", "Salary payment"]);

    const deletedPaidBy = await executeMcpRead(t, grant._id, {
      kind: "search_transactions",
      circleRef,
      filters: { query: "Deleted paid" },
      ...searchTransactionPage(1, 25),
    });
    expect(
      deletedPaidBy.ok &&
        deletedPaidBy.value.pagination === "offset" &&
        deletedPaidBy.value.transactions[0]?.paidBy.displayName,
    ).toBe("Deleted Member");

    const archivedDetail = await executeMcpRead(t, grant._id, {
      kind: "get_transaction",
      circleRef,
      transactionRef: buildRef("Archived detail", seeded.archivedId),
    });
    expect(archivedDetail).toMatchObject({
      ok: true,
      value: { title: "Archived detail", status: "archived" },
    });

    const deselectedSearch = await executeMcpRead(t, grant._id, {
      kind: "search_transactions",
      circleRef: buildRef("Other", other.circleId),
      ...searchTransactionPage(1, 25),
    });
    expect(deselectedSearch).toMatchObject({ ok: false, error: "circle_inaccessible" });

    const capped = await executeMcpRead(t, grant._id, {
      kind: "search_transactions",
      circleRef,
      filters: { query: "cap-row" },
      ...searchTransactionPage(1, 5),
    });
    expect(capped.ok && capped.value.pagination === "offset" && capped.value.totalCountCapped).toBe(
      true,
    );
    expect(
      capped.ok && capped.value.pagination === "offset" && capped.value.transactions,
    ).toHaveLength(5);

    const invalidMonth = await executeMcpRead(t, grant._id, {
      kind: "search_transactions",
      circleRef,
      filters: { month: "2026-13" },
      ...searchTransactionPage(1, 25),
    });
    expect(invalidMonth).toMatchObject({ ok: false, error: "invalid_filters" });

    const mixedDateWindows = await executeMcpRead(t, grant._id, {
      kind: "search_transactions",
      circleRef,
      filters: { month: "2026-06", dateFrom: "invalid" },
      ...searchTransactionPage(1, 25),
    });
    expect(mixedDateWindows).toMatchObject({ ok: false, error: "invalid_filters" });

    const mixedPagination = await executeMcpRead(t, grant._id, {
      kind: "search_transactions",
      circleRef,
      page: 2,
      paginationOpts: { numItems: 5, cursor: null },
    });
    expect(mixedPagination).toMatchObject({ ok: false, error: "invalid_filters" });
  });
});

describe("MCP financial report reads", () => {
  it("returns ledger, dashboard, comparison, and category analytics with active-only totals and bounded currency", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "owner@example.com", displayName: "Olive Owner" }),
    );
    const eurCircle = await t.run((ctx) =>
      seedOwnedFixture(ctx, owner.owner, {
        name: "Euro Trip",
        currency: "EUR",
        archived: true,
      }),
    );
    const usdCircle = await t.run((ctx) =>
      seedOwnedFixture(ctx, owner.owner, { name: "USD Trip", currency: "USD" }),
    );
    const other = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Other" }));
    await t.run(async (ctx) => {
      await seedTransaction(ctx, eurCircle, {
        type: "income",
        title: "Salary",
        amountMinorUnits: 100_000,
        date: "2026-06-01",
        categoryIds: [eurCircle.salaryId],
      });
      await seedTransaction(ctx, eurCircle, {
        title: "Lunch",
        amountMinorUnits: 2_500,
        date: "2026-06-02",
        categoryIds: [eurCircle.diningId, eurCircle.groceriesId],
      });
      await seedTransaction(ctx, eurCircle, {
        title: "Archived lunch",
        date: "2026-06-03",
        status: "archived",
        amountMinorUnits: 999,
      });
      await seedTransaction(ctx, eurCircle, { title: "July row", date: "2026-07-01" });
      await seedTransaction(ctx, usdCircle, {
        type: "income",
        title: "USD pay",
        amountMinorUnits: 50_000,
        date: "2026-06-01",
        categoryIds: [usdCircle.salaryId],
      });
    });
    const grant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [eurCircle.circleId, usdCircle.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT_ID,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    const eurRef = buildRef("Euro Trip", eurCircle.circleId);
    const usdRef = buildRef("USD Trip", usdCircle.circleId);

    const emptyLedger = await executeMcpRead(t, grant._id, {
      kind: "get_monthly_ledger",
      circleRef: eurRef,
      month: "2026-05",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(emptyLedger).toMatchObject({
      ok: true,
      value: {
        month: "2026-05",
        totals: { incomeMinor: 0, expenseMinor: 0, netMinor: 0 },
        currency: "EUR",
        transactions: { page: [], isDone: true },
      },
    });

    const ledger = await executeMcpRead(t, grant._id, {
      kind: "get_monthly_ledger",
      circleRef: eurRef,
      month: "2026-06",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(ledger).toMatchObject({
      ok: true,
      value: {
        month: "2026-06",
        totals: { incomeMinor: 100_000, expenseMinor: 2_500, netMinor: 97_500 },
        currency: "EUR",
      },
    });
    if (!ledger.ok || !("value" in ledger)) {
      throw new Error("expected ledger");
    }
    expect(ledger.value.transactions.page.map((txn) => txn.title)).toEqual(["Lunch", "Salary"]);
    expect(JSON.stringify(ledger.value)).not.toContain("archived lunch");

    const dashboard = await executeMcpRead(t, grant._id, {
      kind: "get_dashboard",
      circleRef: eurRef,
      month: "2026-06",
    });
    expect(dashboard).toMatchObject({
      ok: true,
      value: {
        month: "2026-06",
        totals: { incomeMinor: 100_000, expenseMinor: 2_500, netMinor: 97_500 },
        currency: "EUR",
      },
    });
    if (!dashboard.ok || !("value" in dashboard)) {
      throw new Error("expected dashboard");
    }
    expect(dashboard.value.recent.map((txn) => txn.title)).toEqual(["Lunch", "Salary"]);

    const comparison = await executeMcpRead(t, grant._id, {
      kind: "get_monthly_comparison",
      circleRef: eurRef,
      endMonth: "2026-06",
      rangeMonths: 3,
    });
    expect(comparison).toMatchObject({
      ok: true,
      value: {
        currency: "EUR",
        series: [
          { month: "2026-04", incomeMinor: 0, expenseMinor: 0, netMinor: 0 },
          { month: "2026-05", incomeMinor: 0, expenseMinor: 0, netMinor: 0 },
          { month: "2026-06", incomeMinor: 100_000, expenseMinor: 2_500, netMinor: 97_500 },
        ],
      },
    });

    const analytics = await executeMcpRead(t, grant._id, {
      kind: "get_category_analytics",
      circleRef: eurRef,
      month: "2026-06",
      type: "expense",
    });
    expect(analytics).toMatchObject({
      ok: true,
      value: { type: "expense", nonAdditive: true, currency: "EUR", isDone: true },
    });
    if (!analytics.ok || !("value" in analytics)) {
      throw new Error("expected analytics");
    }
    expect(analytics.value.rankingRevision).toMatch(/^\d+:\d+$/);
    expect(analytics.value.page.map((row) => row.name)).toEqual(["Dining", "Groceries"]);
    expect(analytics.value.page.every((row) => row.taggedTotalMinor === 2_500)).toBe(true);
    expect(JSON.stringify(analytics.value)).not.toMatch(/"categoryId":/);

    const analyticsFirstPage = await executeMcpRead(t, grant._id, {
      kind: "get_category_analytics",
      circleRef: eurRef,
      month: "2026-06",
      type: "expense",
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(analyticsFirstPage).toMatchObject({ ok: true });
    if (!analyticsFirstPage.ok || !("value" in analyticsFirstPage)) {
      throw new Error("expected analytics first page");
    }
    expect(analyticsFirstPage.value.page).toHaveLength(1);
    expect(analyticsFirstPage.value.isDone).toBe(false);
    expect(analyticsFirstPage.value.continueCursor).toMatch(/^\{/);
    const firstCursor = JSON.parse(analyticsFirstPage.value.continueCursor);
    expect(firstCursor.revision).toBe(analyticsFirstPage.value.rankingRevision);

    const analyticsSecondPage = await executeMcpRead(t, grant._id, {
      kind: "get_category_analytics",
      circleRef: eurRef,
      month: "2026-06",
      type: "expense",
      paginationOpts: { numItems: 1, cursor: analyticsFirstPage.value.continueCursor },
    });
    expect(analyticsSecondPage).toMatchObject({ ok: true });
    if (!analyticsSecondPage.ok || !("value" in analyticsSecondPage)) {
      throw new Error("expected analytics second page");
    }
    expect(analyticsSecondPage.value.page).toHaveLength(1);
    expect(analyticsSecondPage.value.page[0]?.name).not.toBe(
      analyticsFirstPage.value.page[0]?.name,
    );

    const staleCursor = JSON.stringify({
      revision: "0:0",
      taggedTotalMinor: analyticsFirstPage.value.page[0]?.taggedTotalMinor,
      name: analyticsFirstPage.value.page[0]?.name,
      ref: analyticsFirstPage.value.page[0]?.ref,
    });
    const stalePage = await executeMcpRead(t, grant._id, {
      kind: "get_category_analytics",
      circleRef: eurRef,
      month: "2026-06",
      type: "expense",
      paginationOpts: { numItems: 1, cursor: staleCursor },
    });
    expect(stalePage).toMatchObject({ ok: false, error: "stale_pagination" });

    const usdDashboard = await executeMcpRead(t, grant._id, {
      kind: "get_dashboard",
      circleRef: usdRef,
      month: "2026-06",
    });
    expect(usdDashboard).toMatchObject({
      ok: true,
      value: {
        currency: "USD",
        totals: { incomeMinor: 50_000, expenseMinor: 0, netMinor: 50_000 },
      },
    });

    const deselected = await executeMcpRead(t, grant._id, {
      kind: "get_dashboard",
      circleRef: buildRef("Other", other.circleId),
      month: "2026-06",
    });
    expect(deselected).toMatchObject({ ok: false, error: "circle_inaccessible" });

    const invalidMonth = await executeMcpRead(t, grant._id, {
      kind: "get_monthly_ledger",
      circleRef: eurRef,
      month: "2026-13",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(invalidMonth).toMatchObject({ ok: false, error: "invalid_filters" });

    const invalidComparisonMonth = await executeMcpRead(t, grant._id, {
      kind: "get_monthly_comparison",
      circleRef: eurRef,
      endMonth: "2026-13",
      rangeMonths: 6,
    });
    expect(invalidComparisonMonth).toMatchObject({ ok: false, error: "invalid_filters" });

    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", eurCircle.circleId).eq("userId", owner.userId),
        )
        .unique();
      if (!membership) throw new Error("owner membership missing");
      await ctx.db.patch(membership._id, { status: "removed" });
    });
    const removed = await executeMcpRead(t, grant._id, {
      kind: "get_category_analytics",
      circleRef: eurRef,
      month: "2026-06",
      type: "expense",
    });
    expect(removed).toMatchObject({ ok: false, error: "circle_inaccessible" });
  });

  it("paginates tied category names with the same ref tiebreak as the ranked list", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "owner@example.com", displayName: "Olive Owner" }),
    );
    const f = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Unicode" }));
    const nfcName = "caf\u00e9";
    const nfdName = "cafe\u0301";
    expect(nfcName.localeCompare(nfdName)).toBe(0);

    await t.run(async (ctx) => {
      const nfcId = await makeCategory(ctx, f.circleId, {
        name: nfcName,
        type: "expense",
        creatorUserId: owner.owner._id,
      });
      const nfdId = await makeCategory(ctx, f.circleId, {
        name: nfdName,
        type: "expense",
        creatorUserId: owner.owner._id,
      });
      await seedTransaction(ctx, f, {
        amountMinorUnits: 1_000,
        date: "2026-06-01",
        categoryIds: [nfcId],
      });
      await seedTransaction(ctx, f, {
        amountMinorUnits: 1_000,
        date: "2026-06-02",
        categoryIds: [nfdId],
      });
    });

    const grant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [f.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT_ID,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    const circleRef = buildRef("Unicode", f.circleId);

    const page1 = await executeMcpRead(t, grant._id, {
      kind: "get_category_analytics",
      circleRef,
      month: "2026-06",
      type: "expense",
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(page1).toMatchObject({ ok: true });
    if (!page1.ok || !("value" in page1)) {
      throw new Error("expected analytics page 1");
    }
    expect(page1.value.page).toHaveLength(1);
    expect(page1.value.isDone).toBe(false);

    const page2 = await executeMcpRead(t, grant._id, {
      kind: "get_category_analytics",
      circleRef,
      month: "2026-06",
      type: "expense",
      paginationOpts: { numItems: 1, cursor: page1.value.continueCursor },
    });
    expect(page2).toMatchObject({ ok: true });
    if (!page2.ok || !("value" in page2)) {
      throw new Error("expected analytics page 2");
    }
    expect(page2.value.page).toHaveLength(1);
    expect(page2.value.isDone).toBe(true);
    expect(new Set([page1.value.page[0]?.name, page2.value.page[0]?.name])).toEqual(
      new Set([nfcName, nfdName]),
    );
  });

  it("supports all comparison ranges and rejects insufficient scope", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "owner@example.com", displayName: "Olive Owner" }),
    );
    const f = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Ranges" }));
    const grant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [f.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT_ID,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    const circleRef = buildRef("Ranges", f.circleId);

    for (const rangeMonths of [1, 3, 6, 12] as const) {
      const comparison = await executeMcpRead(t, grant._id, {
        kind: "get_monthly_comparison",
        circleRef,
        endMonth: "2026-06",
        rangeMonths,
      });
      expect(comparison).toMatchObject({ ok: true });
      if (!comparison.ok || !("value" in comparison)) {
        throw new Error("expected comparison");
      }
      expect(comparison.value.series).toHaveLength(rangeMonths);
    }

    const scopeDenied = await executeMcpRead(
      t,
      grant._id,
      {
        kind: "get_dashboard",
        circleRef,
        month: "2026-06",
      },
      [],
    );
    expect(scopeDenied).toMatchObject({ ok: false, error: "insufficient_scope" });
  });
});

describe("MCP Category reads", () => {
  it("lists with type, lifecycle, case-insensitive text, pagination, and omits internal ids", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "owner@example.com", displayName: "Olive Owner" }),
    );
    const f = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Trip" }));
    const other = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Other" }));
    const removedCreator = await t.run((ctx) =>
      addMember(ctx, f.circleId, "cleo@example.com", "Cleo Creator", "removed"),
    );
    const archivedId = await t.run((ctx) =>
      makeCategory(ctx, f.circleId, {
        name: "Old Gas",
        status: "archived",
        creatorUserId: owner.userId,
      }),
    );
    const removedCategoryId = await t.run((ctx) =>
      makeCategory(ctx, f.circleId, {
        name: "Removed Cat",
        creatorUserId: removedCreator.user._id,
      }),
    );
    const grant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [f.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT_ID,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    const circleRef = buildRef("Trip", f.circleId);

    const activeDefault = await executeMcpRead(t, grant._id, {
      kind: "list_categories",
      circleRef,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(activeDefault).toMatchObject({ ok: true });
    if (!activeDefault.ok || !("value" in activeDefault)) {
      throw new Error("expected active category list");
    }
    expect(activeDefault.value.page.map((category) => category.name).sort()).toEqual(
      ["Dining", "Groceries", "Removed Cat", "Salary"].sort(),
    );
    expect(activeDefault.value.page.every((category) => category.status === "active")).toBe(true);
    expect(JSON.stringify(activeDefault.value)).not.toMatch(/"id":/);

    const archivedOnly = await executeMcpRead(t, grant._id, {
      kind: "list_categories",
      circleRef,
      filters: { status: "archived" },
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(archivedOnly.ok && archivedOnly.value.page.map((category) => category.name)).toEqual([
      "Old Gas",
    ]);

    const expenseType = await executeMcpRead(t, grant._id, {
      kind: "list_categories",
      circleRef,
      filters: { type: "expense", status: "all" },
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(
      expenseType.ok && expenseType.value.page.every((category) => category.type === "expense"),
    ).toBe(true);
    expect(
      expenseType.ok && expenseType.value.page.some((category) => category.name === "Old Gas"),
    ).toBe(true);

    const incomeType = await executeMcpRead(t, grant._id, {
      kind: "list_categories",
      circleRef,
      filters: { type: "income" },
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(incomeType.ok && incomeType.value.page.map((category) => category.name)).toEqual([
      "Salary",
    ]);

    const caseInsensitive = await executeMcpRead(t, grant._id, {
      kind: "list_categories",
      circleRef,
      filters: { query: "gRoC" },
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(
      caseInsensitive.ok && caseInsensitive.value.page.map((category) => category.name),
    ).toEqual(["Groceries"]);

    const page1 = await executeMcpRead(t, grant._id, {
      kind: "list_categories",
      circleRef,
      filters: { status: "all" },
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(page1).toMatchObject({ ok: true });
    if (!page1.ok || !("value" in page1)) {
      throw new Error("expected category page 1");
    }
    expect(page1.value.page).toHaveLength(2);
    expect(page1.value.isDone).toBe(false);

    const page2 = await executeMcpRead(t, grant._id, {
      kind: "list_categories",
      circleRef,
      filters: { status: "all" },
      paginationOpts: { numItems: 2, cursor: page1.value.continueCursor },
    });
    expect(page2.ok && page2.value.page.length).toBeGreaterThan(0);

    const deselected = await executeMcpRead(t, grant._id, {
      kind: "list_categories",
      circleRef: buildRef("Other", other.circleId),
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(deselected).toMatchObject({
      ok: false,
      error: "circle_inaccessible",
    });

    expect(archivedId).toBeTruthy();
    expect(removedCategoryId).toBeTruthy();
  });

  it("returns category detail, recent transactions, history, removed creator attribution, and collapses inaccessible refs", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "owner@example.com", displayName: "Olive Owner" }),
    );
    const f = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Selected" }));
    const other = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Other" }));
    const removedCreator = await t.run((ctx) =>
      addMember(ctx, f.circleId, "cleo@example.com", "Cleo Creator", "removed"),
    );
    const removedCategoryId = await t.run((ctx) =>
      makeCategory(ctx, f.circleId, {
        name: "Removed Cat",
        creatorUserId: removedCreator.user._id,
      }),
    );
    const olderTxnId = await t.run((ctx) =>
      seedTransaction(ctx, f, {
        title: "Older shop",
        date: "2026-05-01",
        categoryIds: [f.groceriesId],
        createdAt: 100,
      }),
    );
    const newerTxnId = await t.run((ctx) =>
      seedTransaction(ctx, f, {
        title: "Newer shop",
        date: "2026-05-20",
        categoryIds: [f.groceriesId],
        createdAt: 200,
      }),
    );
    const grant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [f.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT_ID,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    const circleRef = buildRef("Selected", f.circleId);
    const groceriesRef = buildRef("Groceries", f.groceriesId);
    const removedCatRef = buildRef("Removed Cat", removedCategoryId);

    const detail = await executeMcpRead(t, grant._id, {
      kind: "get_category",
      circleRef,
      categoryRef: groceriesRef,
    });
    expect(detail).toMatchObject({
      ok: true,
      value: {
        ref: groceriesRef,
        name: "Groceries",
        type: "expense",
        status: "active",
        canEditFields: true,
        canArchive: true,
      },
    });
    if (!detail.ok || !("value" in detail)) {
      throw new Error("expected category detail");
    }
    expect(detail.value).not.toHaveProperty("id");
    expect(detail.value.creator.displayName).toBe("Olive Owner");

    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", f.circleId).eq("userId", owner.userId),
        )
        .unique();
      if (!membership) {
        throw new Error("owner membership missing");
      }
      await ctx.db.patch(f.groceriesId, {
        name: "Food",
        nameLower: "food",
        color: "teal",
      });
      await recordEvent(ctx, {
        entity: categoryEntity(f.groceriesId, f.circleId),
        actor: membership,
        action: "edited",
        changes: [
          { field: "name", from: "Groceries", to: "Food" },
          { field: "color", from: "Green", to: "Teal" },
        ],
      });
      await ctx.db.patch(f.groceriesId, { status: "archived", archivedAt: Date.now() });
      await recordEvent(ctx, {
        entity: categoryEntity(f.groceriesId, f.circleId),
        actor: membership,
        action: "archived",
        changes: [],
      });
    });
    const archivedDetail = await executeMcpRead(t, grant._id, {
      kind: "get_category",
      circleRef,
      categoryRef: groceriesRef,
    });
    expect(archivedDetail).toMatchObject({
      ok: true,
      value: {
        status: "archived",
        ref: buildRef("Food", f.groceriesId),
        name: "Food",
      },
    });

    const removedCreatorDetail = await executeMcpRead(t, grant._id, {
      kind: "get_category",
      circleRef,
      categoryRef: removedCatRef,
    });
    expect(removedCreatorDetail).toMatchObject({
      ok: true,
      value: { creator: { displayName: "Cleo Creator" } },
    });

    const deletedCreator = await t.run(async (ctx) => {
      const member = await addMember(
        ctx,
        f.circleId,
        "deleted-creator@example.com",
        "Deleted Creator",
      );
      const categoryId = await makeCategory(ctx, f.circleId, {
        name: "Deleted Cat",
        creatorUserId: member.user._id,
      });
      await ctx.db.delete(member.user._id);
      return { categoryId };
    });
    const deletedCreatorDetail = await executeMcpRead(t, grant._id, {
      kind: "get_category",
      circleRef,
      categoryRef: buildRef("Deleted Cat", deletedCreator.categoryId),
    });
    expect(deletedCreatorDetail).toMatchObject({
      ok: true,
      value: { creator: { displayName: "Deleted Creator" } },
    });

    const recent = await executeMcpRead(t, grant._id, {
      kind: "list_category_transactions",
      circleRef,
      categoryRef: groceriesRef,
    });
    expect(recent).toMatchObject({ ok: true });
    if (!recent.ok || !("value" in recent)) {
      throw new Error("expected recent category transactions");
    }
    expect(recent.value.transactions.map((txn) => txn.title)).toEqual(["Newer shop", "Older shop"]);
    expect(recent.value.transactions[0]?.ref).toBe(buildRef("Newer shop", newerTxnId));
    expect(recent.value.transactions[1]?.ref).toBe(buildRef("Older shop", olderTxnId));

    const history = await executeMcpRead(t, grant._id, {
      kind: "list_category_history",
      circleRef,
      categoryRef: groceriesRef,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(history).toMatchObject({ ok: true });
    if (!history.ok || !("value" in history)) {
      throw new Error("expected category history");
    }
    expect(history.value.page.map((event) => event.action)).toEqual(
      expect.arrayContaining(["edited", "archived"]),
    );
    const edited = history.value.page.find((event) => event.action === "edited");
    expect(edited?.changes).toEqual(
      expect.arrayContaining([
        { field: "name", from: "Groceries", to: "Food" },
        { field: "color", from: "Green", to: "Teal" },
      ]),
    );

    const inaccessible = await executeMcpRead(t, grant._id, {
      kind: "get_category",
      circleRef,
      categoryRef: "not-a-category",
    });
    expect(inaccessible).toMatchObject({ ok: false, error: "category_inaccessible" });

    const wrongCircle = await executeMcpRead(t, grant._id, {
      kind: "get_category",
      circleRef,
      categoryRef: buildRef("Salary", other.salaryId),
    });
    expect(wrongCircle).toMatchObject({ ok: false, error: "category_inaccessible" });

    const deselectedDetail = await executeMcpRead(t, grant._id, {
      kind: "get_category",
      circleRef: buildRef("Other", other.circleId),
      categoryRef: groceriesRef,
    });
    expect(deselectedDetail).toMatchObject({ ok: false, error: "circle_inaccessible" });

    const emptyHistory = await executeMcpRead(t, grant._id, {
      kind: "list_category_history",
      circleRef: buildRef("Other", other.circleId),
      categoryRef: groceriesRef,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(emptyHistory).toMatchObject({ ok: false, error: "circle_inaccessible" });

    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", f.circleId).eq("userId", owner.userId),
        )
        .unique();
      if (!membership) throw new Error("owner membership missing");
      await ctx.db.patch(membership._id, { status: "removed" });
    });
    const foodRef = buildRef("Food", f.groceriesId);
    const removedList = await executeMcpRead(t, grant._id, {
      kind: "list_categories",
      circleRef,
      paginationOpts: { numItems: 10, cursor: null },
    });
    const removedDetail = await executeMcpRead(t, grant._id, {
      kind: "get_category",
      circleRef,
      categoryRef: foodRef,
    });
    const removedRecent = await executeMcpRead(t, grant._id, {
      kind: "list_category_transactions",
      circleRef,
      categoryRef: foodRef,
    });
    const removedHistory = await executeMcpRead(t, grant._id, {
      kind: "list_category_history",
      circleRef,
      categoryRef: foodRef,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(removedList).toMatchObject({ ok: false, error: "circle_inaccessible" });
    expect(removedDetail).toMatchObject({ ok: false, error: "circle_inaccessible" });
    expect(removedRecent).toMatchObject({ ok: false, error: "circle_inaccessible" });
    expect(removedHistory).toMatchObject({ ok: false, error: "circle_inaccessible" });
  });
});

describe("cleanupExpiredWorkerNonces", () => {
  it("deletes expired nonces and preserves unexpired nonces", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("mcpWorkerNonces", { nonce: "n-expired-1", expiresAt: now - 10_000 });
      await ctx.db.insert("mcpWorkerNonces", { nonce: "n-expired-2", expiresAt: now - 1_000 });
      await ctx.db.insert("mcpWorkerNonces", { nonce: "n-valid-1", expiresAt: now + 30_000 });
    });

    const deleted = await t.mutation(internal.mcpApproval.cleanupExpiredWorkerNonces, { now });
    expect(deleted).toBe(2);

    await t.run(async (ctx) => {
      const remaining = await ctx.db.query("mcpWorkerNonces").collect();
      expect(remaining.map((r) => r.nonce)).toEqual(["n-valid-1"]);
    });
  });

  it("drains backlogs larger than a single batch", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 150; i++) {
        await ctx.db.insert("mcpWorkerNonces", {
          nonce: `n-batch-${i}`,
          expiresAt: now - 1_000,
        });
      }
    });

    const deleted = await t.mutation(internal.mcpApproval.cleanupExpiredWorkerNonces, { now });
    expect(deleted).toBe(150);

    await t.run(async (ctx) => {
      const remaining = await ctx.db.query("mcpWorkerNonces").collect();
      expect(remaining).toHaveLength(0);
    });
  });

  it("reschedules until expired nonces beyond the per-run cap are gone", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 6; i++) {
        await ctx.db.insert("mcpWorkerNonces", {
          nonce: `n-cap-${i}`,
          expiresAt: now - 1_000,
        });
      }
    });

    const first = await mutateAndDrain(t, () =>
      t.mutation(internal.mcpApproval.cleanupExpiredWorkerNonces, { now, limit: 4 }),
    );
    expect(first).toBe(4);

    await t.run(async (ctx) => {
      const remaining = await ctx.db.query("mcpWorkerNonces").collect();
      expect(remaining).toHaveLength(0);
    });
  });

  it("rejects a non-positive limit without deleting or rescheduling", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("mcpWorkerNonces", { nonce: "n-zero", expiresAt: now - 1_000 });
    });

    const deleted = await mutateAndDrain(t, () =>
      t.mutation(internal.mcpApproval.cleanupExpiredWorkerNonces, { now, limit: 0 }),
    );
    expect(deleted).toBe(0);

    await t.run(async (ctx) => {
      const remaining = await ctx.db.query("mcpWorkerNonces").collect();
      expect(remaining).toHaveLength(1);
    });
  });
});

describe("cleanupExpiredApprovalTokens", () => {
  it("deletes expired approval tokens and preserves unexpired tokens", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const now = Date.now();
    await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
      expiresAt: now - 10_000,
    });
    await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
      expiresAt: now + 300_000,
    });

    const deleted = await t.mutation(internal.mcpApproval.cleanupExpiredApprovalTokens, { now });
    expect(deleted).toBe(1);

    await t.run(async (ctx) => {
      const remaining = await ctx.db.query("mcpApprovalTokens").collect();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.expiresAt).toBeGreaterThan(now);
    });
  });

  it("reschedules until expired approval tokens beyond the per-run cap are gone", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await seedApprovalToken(t, {
        userId: ada.userId,
        circleIds: [ada.personalCircleId],
        expiresAt: now - 10_000 - i,
      });
    }

    const first = await mutateAndDrain(t, () =>
      t.mutation(internal.mcpApproval.cleanupExpiredApprovalTokens, { now, limit: 2 }),
    );
    expect(first).toBe(2);

    await t.run(async (ctx) => {
      const remaining = await ctx.db.query("mcpApprovalTokens").collect();
      expect(remaining).toHaveLength(0);
    });
  });
});

describe("cleanupExpiredPendingMcpGrants", () => {
  it("revokes abandoned pending grants and preserves live pending and active grants", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const now = Date.now();
    const stale = await t.run((ctx) =>
      createPendingMcpGrant(ctx, {
        userId: ada.userId,
        clientId: CLIENT_ID,
        clientKind: "cimd",
        redirectUri: REDIRECT_URI,
        scopes: READ_WRITE,
        allowedCircleIds: [ada.personalCircleId],
        now: now - MCP_PENDING_GRANT_TTL_MS - 1,
      }),
    );
    const fresh = await t.run((ctx) =>
      createPendingMcpGrant(ctx, {
        userId: ada.userId,
        clientId: `${CLIENT_ID}#fresh`,
        clientKind: "cimd",
        redirectUri: REDIRECT_URI,
        scopes: READ_WRITE,
        allowedCircleIds: [ada.personalCircleId],
        now,
      }),
    );
    expect(stale.ok && fresh.ok).toBe(true);
    if (!stale.ok || !fresh.ok) {
      throw new Error("seed failed");
    }
    const { grant: active } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
    });
    await t.mutation(internal.mcpApproval.activateGrantFromWorker, {
      grantId: active._id,
      workerGrantId: "wg-live",
      principalId: active.principalId,
    });

    const revoked = await t.mutation(internal.mcpApproval.cleanupExpiredPendingMcpGrants, { now });
    expect(revoked).toBe(1);

    await t.run(async (ctx) => {
      expect((await ctx.db.get(stale.value._id))?.status).toBe("revoked");
      expect((await ctx.db.get(fresh.value._id))?.status).toBe("pending");
      expect((await ctx.db.get(active._id))?.status).toBe("active");
    });
  });

  it("reschedules until expired pending grants beyond the per-run cap are gone", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await t.run((ctx) =>
        createPendingMcpGrant(ctx, {
          userId: ada.userId,
          clientId: `${CLIENT_ID}#stale-${i}`,
          clientKind: "cimd",
          redirectUri: REDIRECT_URI,
          scopes: READ_WRITE,
          allowedCircleIds: [ada.personalCircleId],
          now: now - MCP_PENDING_GRANT_TTL_MS - 1 - i,
        }),
      );
    }

    const first = await mutateAndDrain(t, () =>
      t.mutation(internal.mcpApproval.cleanupExpiredPendingMcpGrants, { now, limit: 2 }),
    );
    expect(first).toBe(2);

    await t.run(async (ctx) => {
      const pending = await ctx.db
        .query("mcpGrants")
        .withIndex("by_status", (q) => q.eq("status", "pending"))
        .collect();
      expect(pending).toHaveLength(0);
    });
  });
});

describe("activateGrantFromWorker", () => {
  it("activates the pending grant", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const { grant } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
    });

    const result = await t.mutation(internal.mcpApproval.activateGrantFromWorker, {
      grantId: grant._id,
      workerGrantId: "worker-grant-1",
      principalId: grant.principalId,
    });
    expect(result.ok).toBe(true);
    await t.run(async (ctx) => {
      const active = await ctx.db.get(grant._id);
      expect(active?.status).toBe("active");
      expect(active?.workerGrantId).toBe("worker-grant-1");
    });
  });

  it("rejects a principal that doesn't match the grant", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const { grant } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
    });

    expect(
      await t.mutation(internal.mcpApproval.activateGrantFromWorker, {
        grantId: grant._id,
        workerGrantId: "worker-grant-1",
        principalId: "wrong-principal",
      }),
    ).toEqual({ ok: false, error: "principal_mismatch" });
  });
});

describe("validateActiveGrant", () => {
  async function activeGrant(t: ReturnType<typeof convexTest>) {
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const { grant } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
    });
    await t.mutation(internal.mcpApproval.activateGrantFromWorker, {
      grantId: grant._id,
      workerGrantId: "worker-grant-1",
      principalId: grant.principalId,
    });
    return grant;
  }

  it("accepts requested scopes within the live grant's scopes", async () => {
    const t = convexTest(schema, modules);
    const grant = await activeGrant(t);

    const result = await t.query(internal.mcpApproval.validateActiveGrant, {
      grantId: grant._id,
      principalId: grant.principalId,
      requestedScopes: ["pocketcircle:read"],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        grantId: grant._id,
        userId: grant.userId,
        principalId: grant.principalId,
        scopes: ["pocketcircle:read"],
        allowedCircleIds: grant.allowedCircleIds,
      },
    });
  });

  it("rejects a revoked grant", async () => {
    const t = convexTest(schema, modules);
    const grant = await activeGrant(t);
    await t.run(async (ctx) => {
      const { revokeMcpGrant } = await import("./mcpGrant.js");
      await revokeMcpGrant(ctx, { grantId: grant._id });
    });

    expect(
      await t.query(internal.mcpApproval.validateActiveGrant, {
        grantId: grant._id,
        principalId: grant.principalId,
        requestedScopes: ["pocketcircle:read"],
      }),
    ).toEqual({ ok: false, error: "grant_inactive" });
  });

  it("rejects scopes broadened beyond the live grant's scopes", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const { grant } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
      scopes: ["pocketcircle:read"],
    });
    await t.mutation(internal.mcpApproval.activateGrantFromWorker, {
      grantId: grant._id,
      workerGrantId: "worker-grant-1",
      principalId: grant.principalId,
    });

    expect(
      await t.query(internal.mcpApproval.validateActiveGrant, {
        grantId: grant._id,
        principalId: grant.principalId,
        requestedScopes: READ_WRITE,
      }),
    ).toEqual({ ok: false, error: "scope_broadened" });
  });

  it("rejects a principal that doesn't match", async () => {
    const t = convexTest(schema, modules);
    const grant = await activeGrant(t);

    expect(
      await t.query(internal.mcpApproval.validateActiveGrant, {
        grantId: grant._id,
        principalId: "wrong-principal",
        requestedScopes: ["pocketcircle:read"],
      }),
    ).toEqual({ ok: false, error: "principal_mismatch" });
  });
});

describe("MCP Worker bridge HTTP routes", () => {
  /** Signs a Worker→Convex assertion for `body` and returns matching `t.fetch` init. */
  async function workerRequestInit(
    path: string,
    body: unknown,
    overrides: Partial<McpWorkerAssertionPayload> & { privateJwkJson?: string } = {},
  ) {
    const bodyText = JSON.stringify(body);
    const now = Date.now();
    const { privateJwkJson, ...claimOverrides } = overrides;
    const assertion: McpWorkerAssertionPayload = {
      aud: "pocketcircle:mcp-worker",
      method: "POST",
      path,
      bodySha256: await sha256Hex(bodyText),
      iat: now,
      exp: now + MCP_WORKER_ASSERTION_TTL_MS,
      nonce: `nonce-${Math.random()}`,
      ...claimOverrides,
    };
    const token = await signMcpWorkerAssertion(assertion, signingKey(privateJwkJson));
    return {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `PocketCircleWorker ${token}` },
      body: bodyText,
    };
  }

  async function executeLifecycleBridgeOperation(
    kind: "archive_transaction" | "restore_transaction",
    initialStatus: "active" | "archived",
  ) {
    const t = convexTest(schema, modules);
    const { grant, circleRef, transactionRef } = await seedUpdateFixture(
      t,
      initialStatus === "archived" ? { status: "archived" } : undefined,
    );
    const body = {
      grantId: grant._id,
      effectiveScopes: READ_WRITE,
      operation: {
        kind,
        circleRef,
        transactionRef,
      },
    };
    const res = await t.fetch("/mcp/operation", await workerRequestInit("/mcp/operation", body));
    return {
      res,
      expectedStatus: kind === "archive_transaction" ? "archived" : "active",
    };
  }

  it("rejects a request with no Worker assertion", async () => {
    const t = convexTest(schema, modules);
    const response = await t.fetch("/mcp/redeem-approval", {
      method: "POST",
      body: JSON.stringify({ token: "x" }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  it("rejects a Worker assertion signed with an untrusted private key", async () => {
    const t = convexTest(schema, modules);
    const init = await workerRequestInit(
      "/mcp/redeem-approval",
      { token: "x" },
      { privateJwkJson: OTHER_PRIVATE_JWK_JSON },
    );
    expect((await t.fetch("/mcp/redeem-approval", init)).status).toBe(401);
  });

  it("fails closed when MCP_WORKER_VERIFYING_JWKS is unset", async () => {
    const t = convexTest(schema, modules);
    const init = await workerRequestInit("/mcp/redeem-approval", {
      token: "x",
      claimId: "claim-1",
      handoffId: "handoff-1",
    });
    vi.stubEnv("MCP_WORKER_VERIFYING_JWKS", "");
    expect((await t.fetch("/mcp/redeem-approval", init)).status).toBe(401);
  });

  it("rejects a replayed assertion nonce", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const { grant } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
    });
    await t.mutation(internal.mcpApproval.activateGrantFromWorker, {
      grantId: grant._id,
      workerGrantId: "worker-grant-replay",
      principalId: grant.principalId,
    });
    const body = {
      grantId: grant._id,
      principalId: grant.principalId,
      requestedScopes: ["pocketcircle:read"],
    };
    const init = await workerRequestInit("/mcp/validate-grant", body, { nonce: "fixed-nonce" });

    const first = await t.fetch("/mcp/validate-grant", init);
    expect(first.status).toBe(200);
    const replay = await t.fetch("/mcp/validate-grant", init);
    expect(replay.status).toBe(401);
  });

  it("rejects assertions bound to a different path or body", async () => {
    const t = convexTest(schema, modules);
    const body = { token: "x", claimId: "claim-1", handoffId: "handoff-1" };
    const wrongPath = await workerRequestInit("/mcp/activate-grant", body);
    expect((await t.fetch("/mcp/redeem-approval", wrongPath)).status).toBe(401);

    const wrongBody = await workerRequestInit("/mcp/redeem-approval", body);
    wrongBody.body = JSON.stringify({ ...body, handoffId: "handoff-2" });
    expect((await t.fetch("/mcp/redeem-approval", wrongBody)).status).toBe(401);
  });

  it("accepts a Worker assertion signed by the previous rotation key", async () => {
    const t = convexTest(schema, modules);
    const currentJwks = parseMcpWorkerJwks(OTHER_PUBLIC_JWKS_JSON);
    const previousJwks = parseMcpWorkerJwks(PUBLIC_JWKS_JSON);
    if (!currentJwks || !previousJwks) throw new Error("invalid test JWKS");
    vi.stubEnv(
      "MCP_WORKER_VERIFYING_JWKS",
      JSON.stringify({ keys: [currentJwks.keys[0], previousJwks.keys[0]] }),
    );
    const init = await workerRequestInit("/mcp/redeem-approval", {
      token: "x",
      claimId: "claim-1",
      handoffId: "handoff-1",
    });

    expect((await t.fetch("/mcp/redeem-approval", init)).status).toBe(400);
  });

  it("redeems an approval token end-to-end", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const { token, grant } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
    });

    const response = await t.fetch(
      "/mcp/redeem-approval",
      await workerRequestInit("/mcp/redeem-approval", {
        token,
        claimId: "claim-1",
        handoffId: "handoff-1",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      value: {
        grantId: grant._id,
        principalId: grant.principalId,
        clientId: grant.clientId,
        redirectUri: grant.redirectUri,
        resource: MCP_RESOURCE_URI,
        scopes: grant.scopes,
        allowedCircleIds: grant.allowedCircleIds,
        handoffId: "handoff-1",
      },
    });
  });

  it("activates a grant end-to-end", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const { grant } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
    });
    const body = {
      grantId: grant._id,
      workerGrantId: "worker-grant-1",
      principalId: grant.principalId,
    };

    const response = await t.fetch(
      "/mcp/activate-grant",
      await workerRequestInit("/mcp/activate-grant", body),
    );
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.ok).toBe(true);
    await t.run(async (ctx) => {
      expect((await ctx.db.get(grant._id))?.status).toBe("active");
    });
  });

  it("validate-grant rejects a revoked grant via HTTP", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const { grant } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
    });
    await t.mutation(internal.mcpApproval.activateGrantFromWorker, {
      grantId: grant._id,
      workerGrantId: "worker-grant-1",
      principalId: grant.principalId,
    });
    await t.run(async (ctx) => {
      const { revokeMcpGrant } = await import("./mcpGrant.js");
      await revokeMcpGrant(ctx, { grantId: grant._id });
    });
    const body = {
      grantId: grant._id,
      principalId: grant.principalId,
      requestedScopes: ["pocketcircle:read"],
    };

    const response = await t.fetch(
      "/mcp/validate-grant",
      await workerRequestInit("/mcp/validate-grant", body),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "grant_inactive" });
  });

  it("rejects a malformed body", async () => {
    const t = convexTest(schema, modules);
    const response = await t.fetch(
      "/mcp/redeem-approval",
      await workerRequestInit("/mcp/redeem-approval", { notAToken: 1 }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "invalid_body" });
  });

  it("executes get_current_user and list_authorized_circles via /mcp/operation", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada Lovelace" }),
    );
    const { grant } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
      scopes: ["pocketcircle:read"],
    });
    await t.mutation(internal.mcpApproval.activateGrantFromWorker, {
      grantId: grant._id,
      workerGrantId: "worker-grant-op-1",
      principalId: grant.principalId,
    });

    const userOpBody = {
      grantId: grant._id,
      effectiveScopes: ["pocketcircle:read"],
      operation: { kind: "get_current_user" as const },
    };
    const userRes = await t.fetch(
      "/mcp/operation",
      await workerRequestInit("/mcp/operation", userOpBody),
    );
    expect(userRes.status).toBe(200);
    expect(await userRes.json()).toEqual({
      ok: true,
      value: {
        id: ada.userId,
        displayName: "Ada Lovelace",
        image: null,
        createdAt: expect.any(Number),
      },
    });

    const circlesOpBody = {
      grantId: grant._id,
      effectiveScopes: ["pocketcircle:read"],
      operation: { kind: "list_authorized_circles" as const },
    };
    const circlesRes = await t.fetch(
      "/mcp/operation",
      await workerRequestInit("/mcp/operation", circlesOpBody),
    );
    expect(circlesRes.status).toBe(200);
    const circlesJson: unknown = await circlesRes.json();
    expect(circlesJson).toMatchObject({
      ok: true,
      value: {
        circles: [
          {
            id: ada.personalCircleId,
            kind: "personal",
            isOwner: true,
            status: "active",
          },
        ],
      },
    });

    await t.run(async (ctx) => {
      const updatedGrant = await ctx.db.get(grant._id);
      expect(updatedGrant?.lastUsedAt).toBeTypeOf("number");
      expect(updatedGrant?.lastUsedAt).toBeGreaterThan(0);
    });
  });

  it("/mcp/operation rejects insufficient scope or inactive grant", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const { grant } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
      scopes: ["pocketcircle:write"],
    });
    await t.mutation(internal.mcpApproval.activateGrantFromWorker, {
      grantId: grant._id,
      workerGrantId: "worker-grant-op-2",
      principalId: grant.principalId,
    });

    // Grant only has write, but read is required
    const missingScopeBody = {
      grantId: grant._id,
      effectiveScopes: ["pocketcircle:write"],
      operation: { kind: "get_current_user" as const },
    };
    const missingScopeRes = await t.fetch(
      "/mcp/operation",
      await workerRequestInit("/mcp/operation", missingScopeBody),
    );
    expect(missingScopeRes.status).toBe(400);
    expect(await missingScopeRes.json()).toMatchObject({
      ok: false,
      error: "insufficient_scope",
    });
  });

  it("executes create_transaction via /mcp/operation", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "bridge@example.com", displayName: "Bridge Owner" }),
    );
    const f = await t.run((ctx) =>
      seedOwnedFixture(ctx, owner.owner, { name: "Trip", currency: "USD" }),
    );
    const grant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [f.circleId],
      scopes: READ_WRITE,
      clientId: CLIENT_ID,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    const body = {
      grantId: grant._id,
      effectiveScopes: READ_WRITE,
      operation: {
        kind: "create_transaction" as const,
        circleRef: buildRef("Trip", f.circleId),
        type: "expense" as const,
        title: "Bridge lunch",
        amountMinorUnits: 1_200,
        date: "2026-06-04",
        categoryRefs: [buildRef("Groceries", f.groceriesId)],
        expectedCurrency: "USD",
      },
    };
    const res = await t.fetch("/mcp/operation", await workerRequestInit("/mcp/operation", body));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      value: {
        ref: expect.any(String),
        transaction: expect.objectContaining({ title: "Bridge lunch" }),
      },
    });
    await t.run(async (ctx) => {
      const updatedGrant = await ctx.db.get(grant._id);
      expect(updatedGrant?.lastUsedAt).toBeTypeOf("number");
    });
  });

  it("executes update_transaction via /mcp/operation", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "bridge-update@example.com",
        displayName: "Bridge Owner",
      }),
    );
    const f = await t.run((ctx) =>
      seedOwnedFixture(ctx, owner.owner, { name: "Trip", currency: "USD" }),
    );
    const txnId = await t.run((ctx) => seedTransaction(ctx, f, { title: "Bridge lunch" }));
    const grant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [f.circleId],
      scopes: READ_WRITE,
      clientId: CLIENT_ID,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    const body = {
      grantId: grant._id,
      effectiveScopes: READ_WRITE,
      operation: {
        kind: "update_transaction" as const,
        circleRef: buildRef("Trip", f.circleId),
        transactionRef: buildRef("Bridge lunch", txnId),
        title: "Bridge edit",
      },
    };
    const res = await t.fetch("/mcp/operation", await workerRequestInit("/mcp/operation", body));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      value: {
        ref: expect.any(String),
        transaction: expect.objectContaining({ title: "Bridge edit" }),
      },
    });
  });

  it("executes archive_transaction via /mcp/operation", async () => {
    const { res, expectedStatus } = await executeLifecycleBridgeOperation(
      "archive_transaction",
      "active",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      value: {
        transaction: expect.objectContaining({ status: expectedStatus }),
      },
    });
    expect(JSON.stringify(body)).not.toContain("amountMinorUnits");
  });

  it("executes restore_transaction via /mcp/operation", async () => {
    const { res, expectedStatus } = await executeLifecycleBridgeOperation(
      "restore_transaction",
      "archived",
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      value: {
        transaction: expect.objectContaining({ status: expectedStatus }),
      },
    });
    expect(JSON.stringify(body)).not.toContain("amountMinorUnits");
  });
});

describe("MCP create_transaction write", () => {
  it("creates expense and income with default and explicit Paid By, history, notification, checklist, and currency lock", async () => {
    const t = convexTest(schema, modules);
    const { owner, f, member, grant, circleRef } = await seedMcpWriteFixture(t);
    const groceriesRef = buildRef("Groceries", f.groceriesId);
    const diningRef = buildRef("Dining", f.diningId);
    const salaryRef = buildRef("Salary", f.salaryId);

    const expense = await mutateAndDrain(t, () =>
      executeMcpWrite(t, grant._id, {
        kind: "create_transaction",
        circleRef,
        type: "expense",
        title: "Team lunch",
        note: "  ",
        amountMinorUnits: 2_500,
        date: "2026-06-01",
        categoryRefs: [groceriesRef, diningRef],
        paidByMemberId: String(member.memberId),
        expectedCurrency: "USD",
      }),
    );
    expect(expense).toMatchObject({ ok: true });
    if (!expense.ok) {
      throw new Error("expected expense create");
    }
    expect(expense.value.transaction.title).toBe("Team lunch");
    expect(expense.value.transaction.note).toBeUndefined();
    expect(expense.value.transaction.paidBy.displayName).toBe("Maya Member");
    expect(expense.value.transaction.recordedBy.displayName).toBe("Writer Owner");
    expect(expense.value.ref).toBe(expense.value.transaction.ref);

    const income = await executeMcpWrite(t, grant._id, {
      kind: "create_transaction",
      circleRef,
      type: "income",
      title: "Paycheck",
      amountMinorUnits: 500_000,
      date: "2026-06-02",
      categoryRefs: [salaryRef],
      expectedCurrency: "USD",
    });
    expect(income).toMatchObject({ ok: true });
    if (!income.ok) {
      throw new Error("expected income create");
    }
    expect(income.value.transaction.paidBy.displayName).toBe("Writer Owner");

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(f.circleId);
      expect(circle?.currencyLocked).toBe(true);
      const activation = await ctx.db
        .query("userActivation")
        .withIndex("by_user", (q) => q.eq("userId", owner.userId))
        .unique();
      expect(activation?.transactionCreatedAt).toEqual(expect.any(Number));
      const createdTxn = await ctx.db
        .query("transactions")
        .withIndex("by_circle_and_date", (q) => q.eq("circleId", f.circleId))
        .filter((q) => q.eq(q.field("title"), "Team lunch"))
        .first();
      const histories = await ctx.db.query("histories").collect();
      expect(
        histories.some((event) => event.entityId === createdTxn?._id && event.action === "created"),
      ).toBe(true);
      expect(await listNotificationsForUser(ctx, member.user._id)).toHaveLength(1);
    });
  });

  it("rejects validation, lifecycle, scope, grant, and circle access failures without partial writes", async () => {
    const t = convexTest(schema, modules);
    const { owner, f, member, grant, circleRef } = await seedMcpWriteFixture(t);
    const other = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Other" }));
    const incomplete = await t.run((ctx) =>
      seedOwnedCircle(ctx, owner.owner, { name: "Draft", setupCompletedAt: null }),
    );
    const archived = await t.run((ctx) =>
      seedOwnedCircle(ctx, owner.owner, { name: "Archived", archived: true }),
    );
    const archivedCategory = await t.run((ctx) =>
      makeCategory(ctx, f.circleId, {
        name: "Old snacks",
        status: "archived",
        creatorUserId: owner.userId,
      }),
    );
    const incomeCategory = buildRef("Salary", f.salaryId);
    const expenseCategory = buildRef("Groceries", f.groceriesId);
    const base = {
      kind: "create_transaction" as const,
      circleRef,
      type: "expense" as const,
      title: "Coffee",
      amountMinorUnits: 500,
      date: "2026-06-03",
      categoryRefs: [expenseCategory],
      expectedCurrency: "USD",
    };

    expect(await executeMcpWrite(t, grant._id, { ...base, amountMinorUnits: 0 })).toMatchObject({
      ok: false,
      error: "validation_failed",
    });
    expect(
      await executeMcpWrite(t, grant._id, { ...base, amountMinorUnits: MAX_AMOUNT_MINOR + 1 }),
    ).toMatchObject({
      ok: false,
      error: "validation_failed",
    });
    expect(await executeMcpWrite(t, grant._id, { ...base, title: "   " })).toMatchObject({
      ok: false,
      error: "validation_failed",
    });
    expect(await executeMcpWrite(t, grant._id, { ...base, date: "2026-13-01" })).toMatchObject({
      ok: false,
      error: "validation_failed",
    });
    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        note: "x".repeat(LIMITS.transactionNoteMax + 1),
      }),
    ).toMatchObject({
      ok: false,
      error: "validation_failed",
    });
    expect(await executeMcpWrite(t, grant._id, { ...base, expectedCurrency: "EUR" })).toMatchObject(
      { ok: false, error: "currency_changed" },
    );
    expect(await executeMcpWrite(t, grant._id, { ...base, expectedCurrency: "ZZZ" })).toMatchObject(
      { ok: false, error: "currency_unsupported" },
    );
    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        categoryRefs: [expenseCategory, expenseCategory],
      }),
    ).toMatchObject({ ok: false, error: "validation_failed" });
    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        categoryRefs: [incomeCategory],
      }),
    ).toMatchObject({ ok: false, error: "category_inaccessible" });
    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        categoryRefs: [buildRef("Old snacks", archivedCategory)],
      }),
    ).toMatchObject({ ok: false, error: "category_inaccessible" });
    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        paidByMemberId: String(member.memberId),
      }),
    ).toMatchObject({ ok: true });
    await t.run(async (ctx) => {
      const membership = await ctx.db.get(member.memberId);
      if (!membership) throw new Error("member missing");
      await ctx.db.patch(member.memberId, { status: "removed" });
    });
    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        paidByMemberId: String(member.memberId),
      }),
    ).toMatchObject({ ok: false, error: "paid_by_invalid" });

    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        circleRef: buildRef("Other", other.circleId),
      }),
    ).toMatchObject({ ok: false, error: "circle_inaccessible" });
    await t.run(async (ctx) => {
      const updatedGrant = await ctx.db.get(grant._id);
      expect(updatedGrant?.lastUsedAt).toBeTypeOf("number");
    });
    expect(
      await executeMcpWrite(t, grant._id, { ...base, circleRef: "not-a-circle" }),
    ).toMatchObject({ ok: false, error: "circle_inaccessible" });

    expect(await executeMcpWrite(t, grant._id, base, ["pocketcircle:read"])).toMatchObject({
      ok: false,
      error: "insufficient_scope",
    });

    const readOnlyGrant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [f.circleId],
      scopes: ["pocketcircle:read"],
      clientId: `${CLIENT_ID}/read-only-grant`,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    expect(await executeMcpWrite(t, readOnlyGrant._id, base, READ_WRITE)).toMatchObject({
      ok: false,
      error: "insufficient_scope",
    });

    expect(
      await executeMcpWrite(
        t,
        grant._id,
        { ...base, circleRef: buildRef("Draft", incomplete.circleId) },
        READ_WRITE,
      ),
    ).toMatchObject({ ok: false, error: "circle_inaccessible" });

    const incompleteGrant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [incomplete.circleId],
      scopes: READ_WRITE,
      clientId: `${CLIENT_ID}/incomplete`,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    expect(
      await executeMcpWrite(t, incompleteGrant._id, {
        ...base,
        circleRef: buildRef("Draft", incomplete.circleId),
      }),
    ).toMatchObject({ ok: false, error: "circle_setup_incomplete" });

    const archivedGrant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [archived.circleId],
      scopes: READ_WRITE,
      clientId: `${CLIENT_ID}/archived`,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    expect(
      await executeMcpWrite(t, archivedGrant._id, {
        ...base,
        circleRef: buildRef("Archived", archived.circleId),
      }),
    ).toMatchObject({ ok: false, error: "circle_archived" });

    await t.run((ctx) => ctx.db.patch(grant._id, { status: "revoked", revokedAt: Date.now() }));
    expect(await executeMcpWrite(t, grant._id, base)).toMatchObject({
      ok: false,
      error: "grant_unavailable",
    });

    const freshGrant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [f.circleId],
      scopes: READ_WRITE,
      clientId: `${CLIENT_ID}/removed`,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", f.circleId).eq("userId", owner.userId),
        )
        .unique();
      if (!membership) throw new Error("owner membership missing");
      await ctx.db.patch(membership._id, { status: "removed" });
    });
    expect(await executeMcpWrite(t, freshGrant._id, base)).toMatchObject({
      ok: false,
      error: "circle_inaccessible",
    });
  });
});

describe("MCP update_transaction write", () => {
  it("updates each field, combined edits, type change, Paid By, history, and search sync", async () => {
    const t = convexTest(schema, modules);
    const { member, grant, circleRef, transactionRef, groceriesRef, diningRef, salaryRef, txnId } =
      await seedUpdateFixture(t);

    const titleOnly = await executeMcpWrite(t, grant._id, {
      kind: "update_transaction",
      circleRef,
      transactionRef,
      title: "  Team dinner  ",
    });
    expect(titleOnly).toMatchObject({ ok: true });
    if (!titleOnly.ok) throw new Error("expected title update");
    expect(titleOnly.value.transaction.title).toBe("Team dinner");

    const combined = await executeMcpWrite(t, grant._id, {
      kind: "update_transaction",
      circleRef,
      transactionRef,
      note: "  Ramen  ",
      date: "2026-06-02",
      amountMinorUnits: 3_000,
      expectedCurrency: "USD",
      categoryRefs: [groceriesRef, diningRef],
      paidByMemberId: String(member.memberId),
    });
    expect(combined).toMatchObject({ ok: true });
    if (!combined.ok) throw new Error("expected combined update");
    expect(combined.value.transaction.note).toBe("Ramen");
    expect(combined.value.transaction.date).toBe("2026-06-02");
    expect(combined.value.transaction.amountMinorUnits).toBe(3_000);
    expect(combined.value.transaction.paidBy.displayName).toBe("Maya Member");
    expect(combined.value.transaction.audit.updatedBy.displayName).toBe("Updater Owner");
    expect(combined.value.transaction.audit.updatedAt).toEqual(expect.any(Number));

    const typeChanged = await executeMcpWrite(t, grant._id, {
      kind: "update_transaction",
      circleRef,
      transactionRef,
      type: "income",
      categoryRefs: [salaryRef],
    });
    expect(typeChanged).toMatchObject({ ok: true });
    if (!typeChanged.ok) throw new Error("expected type change");
    expect(typeChanged.value.transaction.type).toBe("income");

    await t.run(async (ctx) => {
      const histories = await ctx.db.query("histories").collect();
      const txnHistories = histories.filter((event) => event.entityId === txnId);
      expect(txnHistories.some((event) => event.action === "edited")).toBe(true);
      expect(txnHistories.some((event) => event.action === "type changed")).toBe(true);
      const searchDoc = await ctx.db
        .query("transactionSearchDocuments")
        .withIndex("by_transaction", (q) => q.eq("transactionId", txnId))
        .unique();
      expect(searchDoc?.searchText).toContain("team dinner");
    });
  });

  it("returns safely on a true no-op without history or notification", async () => {
    const t = convexTest(schema, modules);
    const { owner, grant, circleRef, transactionRef, groceriesRef, txnId } =
      await seedUpdateFixture(t);
    const before = await t.run(async (ctx) => (await ctx.db.get(txnId))?.updatedAt);
    const result = await executeMcpWrite(t, grant._id, {
      kind: "update_transaction",
      circleRef,
      transactionRef,
      title: "Team lunch",
      amountMinorUnits: 2_500,
      expectedCurrency: "USD",
      categoryRefs: [groceriesRef],
    });
    expect(result).toMatchObject({ ok: true });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(txnId))?.updatedAt).toBe(before);
      const histories = await ctx.db.query("histories").collect();
      expect(histories.some((event) => event.entityId === txnId)).toBe(false);
      expect(await listNotificationsForUser(ctx, owner.userId)).toHaveLength(0);
    });
  });

  it("keeps an already-attached archived category on field-only edit", async () => {
    const t = convexTest(schema, modules);
    const { f, grant, circleRef, transactionRef, groceriesRef, txnId } = await seedUpdateFixture(t);
    await t.run((ctx) =>
      ctx.db.patch(f.groceriesId, { status: "archived", archivedAt: Date.now() }),
    );
    const updated = await executeMcpWrite(t, grant._id, {
      kind: "update_transaction",
      circleRef,
      transactionRef,
      title: "Renamed lunch",
      categoryRefs: [groceriesRef],
    });
    expect(updated).toMatchObject({ ok: true });
    await t.run(async (ctx) => {
      const links = await ctx.db
        .query("transactionCategories")
        .withIndex("by_transaction", (q) => q.eq("transactionId", txnId))
        .collect();
      expect(links.map((link) => link.categoryId)).toEqual([f.groceriesId]);
    });
  });

  it("preserves readable Paid By attribution for a removed Member", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "attr@example.com", displayName: "Attr Owner" }),
    );
    const f = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Attr" }));
    const removed = await t.run((ctx) =>
      addMember(ctx, f.circleId, "gone@example.com", "Gone Member", "removed"),
    );
    const txnId = await t.run((ctx) =>
      seedTransaction(ctx, f, {
        title: "Old lunch",
        paidByMemberId: removed.memberId,
      }),
    );
    const grant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [f.circleId],
      scopes: READ_WRITE,
      clientId: `${CLIENT_ID}/attr`,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    const updated = await executeMcpWrite(t, grant._id, {
      kind: "update_transaction",
      circleRef: buildRef("Attr", f.circleId),
      transactionRef: buildRef("Old lunch", txnId),
      title: "Renamed lunch",
    });
    expect(updated).toMatchObject({
      ok: true,
      value: { transaction: { paidBy: { displayName: "Gone Member" } } },
    });
  });

  it("rejects Owner edits on another Member's transaction", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "owner2@example.com", displayName: "Circle Owner" }),
    );
    const f = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Shared" }));
    const member = await t.run((ctx) =>
      addMember(ctx, f.circleId, "recorder@example.com", "Recorder Member"),
    );
    const txnId = await t.run((ctx) =>
      seedTransaction(ctx, f, {
        title: "Member txn",
        recordedByMemberId: member.memberId,
      }),
    );
    const grant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [f.circleId],
      scopes: READ_WRITE,
      clientId: CLIENT_ID,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    expect(
      await executeMcpWrite(t, grant._id, {
        kind: "update_transaction",
        circleRef: buildRef("Shared", f.circleId),
        transactionRef: buildRef("Member txn", txnId),
        title: "Owner rewrite",
      }),
    ).toMatchObject({ ok: false, error: "transaction_inaccessible" });
  });

  it("allows a rejoined Recorded By Member to edit again", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "owner3@example.com", displayName: "Owner Three" }),
    );
    const f = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Rejoin" }));
    const member = await t.run((ctx) =>
      addMember(ctx, f.circleId, "returner@example.com", "Returner"),
    );
    const txnId = await t.run((ctx) =>
      seedTransaction(ctx, f, {
        title: "Returner txn",
        recordedByMemberId: member.memberId,
      }),
    );
    const grant = await createActiveMcpGrant(t, {
      userId: member.user._id,
      circleIds: [f.circleId],
      scopes: READ_WRITE,
      clientId: `${CLIENT_ID}/rejoin`,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(member.memberId, { status: "removed" });
    });
    expect(
      await executeMcpWrite(t, grant._id, {
        kind: "update_transaction",
        circleRef: buildRef("Rejoin", f.circleId),
        transactionRef: buildRef("Returner txn", txnId),
        title: "While removed",
      }),
    ).toMatchObject({ ok: false, error: "circle_inaccessible" });
    await t.run(async (ctx) => {
      await ctx.db.patch(member.memberId, { status: "active" });
    });
    expect(
      await executeMcpWrite(t, grant._id, {
        kind: "update_transaction",
        circleRef: buildRef("Rejoin", f.circleId),
        transactionRef: buildRef("Returner txn", txnId),
        title: "Back again",
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects validation, lifecycle, scope, category, Paid By, and access failures without partial writes", async () => {
    const t = convexTest(schema, modules);
    const { owner, f, member, grant, circleRef, transactionRef, groceriesRef, txnId } =
      await seedUpdateFixture(t);
    const other = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Other" }));
    const incomplete = await t.run((ctx) =>
      seedOwnedFixture(ctx, owner.owner, { name: "Draft", setupCompletedAt: null }),
    );
    const archivedCircle = await t.run((ctx) =>
      seedOwnedFixture(ctx, owner.owner, { name: "Archived", archived: true }),
    );
    const archivedCategory = await t.run((ctx) =>
      makeCategory(ctx, f.circleId, {
        name: "Old snacks",
        status: "archived",
        creatorUserId: owner.userId,
      }),
    );
    const archivedTxnId = await t.run((ctx) =>
      seedTransaction(ctx, f, { title: "Archived txn", status: "archived" }),
    );
    const incompleteTxnId = await t.run((ctx) =>
      seedTransaction(ctx, incomplete, { title: "Draft txn" }),
    );
    const archivedCircleTxnId = await t.run((ctx) =>
      seedTransaction(ctx, archivedCircle, { title: "Archived circle txn" }),
    );

    const base = {
      kind: "update_transaction" as const,
      circleRef,
      transactionRef,
      title: "Edited",
    };

    expect(
      await executeMcpWrite(t, grant._id, {
        kind: "update_transaction",
        circleRef,
        transactionRef,
      }),
    ).toMatchObject({ ok: false, error: "validation_failed" });
    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        amountMinorUnits: 0,
        expectedCurrency: "USD",
      }),
    ).toMatchObject({ ok: false, error: "validation_failed" });
    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        amountMinorUnits: 500,
      }),
    ).toMatchObject({ ok: false, error: "validation_failed" });
    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        amountMinorUnits: 500,
        expectedCurrency: "EUR",
      }),
    ).toMatchObject({ ok: false, error: "currency_changed" });
    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        type: "income",
      }),
    ).toMatchObject({ ok: false, error: "validation_failed" });
    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        type: "income",
        categoryRefs: [groceriesRef],
      }),
    ).toMatchObject({ ok: false, error: "category_inaccessible" });
    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        categoryRefs: [buildRef("Old snacks", archivedCategory)],
      }),
    ).toMatchObject({ ok: false, error: "category_inaccessible" });
    await t.run(async (ctx) => {
      await ctx.db.patch(member.memberId, { status: "removed" });
    });
    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        paidByMemberId: String(member.memberId),
      }),
    ).toMatchObject({ ok: false, error: "paid_by_invalid" });
    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        circleRef: buildRef("Other", other.circleId),
      }),
    ).toMatchObject({ ok: false, error: "circle_inaccessible" });
    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        transactionRef: buildRef("Archived txn", archivedTxnId),
      }),
    ).toMatchObject({ ok: false, error: "transaction_inaccessible" });
    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        transactionRef: "not-a-transaction",
      }),
    ).toMatchObject({ ok: false, error: "transaction_inaccessible" });
    expect(await executeMcpWrite(t, grant._id, base, ["pocketcircle:read"])).toMatchObject({
      ok: false,
      error: "insufficient_scope",
    });
    const readOnlyGrant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [f.circleId],
      scopes: ["pocketcircle:read"],
      clientId: `${CLIENT_ID}/update-read-only`,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    expect(await executeMcpWrite(t, readOnlyGrant._id, base, READ_WRITE)).toMatchObject({
      ok: false,
      error: "insufficient_scope",
    });
    const incompleteGrant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [incomplete.circleId],
      scopes: READ_WRITE,
      clientId: `${CLIENT_ID}/update-incomplete`,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    expect(
      await executeMcpWrite(t, incompleteGrant._id, {
        kind: "update_transaction",
        circleRef: buildRef("Draft", incomplete.circleId),
        transactionRef: buildRef("Draft txn", incompleteTxnId),
        title: "Edited",
      }),
    ).toMatchObject({ ok: false, error: "circle_setup_incomplete" });
    const archivedGrant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [archivedCircle.circleId],
      scopes: READ_WRITE,
      clientId: `${CLIENT_ID}/update-archived-circle`,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    expect(
      await executeMcpWrite(t, archivedGrant._id, {
        kind: "update_transaction",
        circleRef: buildRef("Archived", archivedCircle.circleId),
        transactionRef: buildRef("Archived circle txn", archivedCircleTxnId),
        title: "Edited",
      }),
    ).toMatchObject({ ok: false, error: "circle_archived" });

    await t.run((ctx) => ctx.db.patch(grant._id, { status: "revoked", revokedAt: Date.now() }));
    expect(await executeMcpWrite(t, grant._id, base)).toMatchObject({
      ok: false,
      error: "grant_unavailable",
    });

    const freshGrant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [f.circleId],
      scopes: READ_WRITE,
      clientId: `${CLIENT_ID}/update-removed`,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", f.circleId).eq("userId", owner.userId),
        )
        .unique();
      if (!membership) throw new Error("owner membership missing");
      await ctx.db.patch(membership._id, { status: "removed" });
    });
    expect(await executeMcpWrite(t, freshGrant._id, base)).toMatchObject({
      ok: false,
      error: "circle_inaccessible",
    });

    await t.run(async (ctx) => {
      const unchanged = await ctx.db.get(txnId);
      expect(unchanged?.title).toBe("Team lunch");
    });
  });
});

type LifecycleWriteKind = "archive_transaction" | "restore_transaction";

async function runLifecycleWriteDenialSuite(kind: LifecycleWriteKind) {
  const t = convexTest(schema, modules);
  const isArchive = kind === "archive_transaction";
  const clientPrefix = isArchive ? "archive" : "restore";
  const { owner, f, member, grant, circleRef, transactionRef, txnId } = await seedUpdateFixture(
    t,
    isArchive ? undefined : { status: "archived" },
  );
  const other = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Other" }));
  const incomplete = await t.run((ctx) =>
    seedOwnedFixture(ctx, owner.owner, { name: "Draft", setupCompletedAt: null }),
  );
  const archivedCircle = await t.run((ctx) =>
    seedOwnedFixture(ctx, owner.owner, { name: "Archived", archived: true }),
  );
  const edgeInvalidRef = await t.run(async (ctx) => {
    if (isArchive) {
      const archivedTxnId = await seedTransaction(ctx, f, {
        title: "Already archived",
        status: "archived",
      });
      return buildRef("Already archived", archivedTxnId);
    }
    const activeTxnId = await seedTransaction(ctx, f, { title: "Active txn", status: "active" });
    return buildRef("Active txn", activeTxnId);
  });
  const incompleteTxnId = await t.run((ctx) =>
    seedTransaction(ctx, incomplete, {
      title: "Draft txn",
      ...(isArchive ? {} : { status: "archived" as const }),
    }),
  );
  const archivedCircleTxnId = await t.run((ctx) =>
    seedTransaction(ctx, archivedCircle, {
      title: "Archived circle txn",
      ...(isArchive ? {} : { status: "archived" as const }),
    }),
  );
  const memberGrant = await createActiveMcpGrant(t, {
    userId: member.user._id,
    circleIds: [f.circleId],
    scopes: READ_WRITE,
    clientId: `${CLIENT_ID}/${clientPrefix}-deny`,
    clientKind: "static",
    redirectUri: REDIRECT_URI,
  });

  expect(
    await executeMcpWrite(t, memberGrant._id, {
      kind,
      circleRef,
      transactionRef,
    }),
  ).toMatchObject({ ok: false, error: "transaction_inaccessible" });
  await t.run(async (ctx) => {
    expect(await listNotificationsForUser(ctx, owner.userId)).toHaveLength(0);
    expect(await listNotificationsForUser(ctx, member.user._id)).toHaveLength(0);
  });

  const succeeded = await executeMcpWrite(t, grant._id, {
    kind,
    circleRef,
    transactionRef,
  });
  expect(succeeded).toMatchObject({ ok: true });
  expect(
    await executeMcpWrite(t, grant._id, {
      kind,
      circleRef,
      transactionRef,
    }),
  ).toMatchObject({ ok: false, error: "transaction_inaccessible" });
  expect(
    await executeMcpWrite(t, grant._id, {
      kind,
      circleRef,
      transactionRef: edgeInvalidRef,
    }),
  ).toMatchObject({ ok: false, error: "transaction_inaccessible" });
  expect(
    await executeMcpWrite(t, grant._id, {
      kind,
      circleRef: buildRef("Other", other.circleId),
      transactionRef,
    }),
  ).toMatchObject({ ok: false, error: "circle_inaccessible" });
  expect(
    await executeMcpWrite(t, grant._id, {
      kind,
      circleRef,
      transactionRef: "not-a-transaction",
    }),
  ).toMatchObject({ ok: false, error: "transaction_inaccessible" });
  expect(
    await executeMcpWrite(
      t,
      grant._id,
      {
        kind,
        circleRef,
        transactionRef,
      },
      ["pocketcircle:read"],
    ),
  ).toMatchObject({ ok: false, error: "insufficient_scope" });

  const incompleteGrant = await createActiveMcpGrant(t, {
    userId: owner.userId,
    circleIds: [incomplete.circleId],
    scopes: READ_WRITE,
    clientId: `${CLIENT_ID}/${clientPrefix}-incomplete`,
    clientKind: "static",
    redirectUri: REDIRECT_URI,
  });
  expect(
    await executeMcpWrite(t, incompleteGrant._id, {
      kind,
      circleRef: buildRef("Draft", incomplete.circleId),
      transactionRef: buildRef("Draft txn", incompleteTxnId),
    }),
  ).toMatchObject({ ok: false, error: "circle_setup_incomplete" });

  const archivedGrant = await createActiveMcpGrant(t, {
    userId: owner.userId,
    circleIds: [archivedCircle.circleId],
    scopes: READ_WRITE,
    clientId: `${CLIENT_ID}/${clientPrefix}-archived-circle`,
    clientKind: "static",
    redirectUri: REDIRECT_URI,
  });
  expect(
    await executeMcpWrite(t, archivedGrant._id, {
      kind,
      circleRef: buildRef("Archived", archivedCircle.circleId),
      transactionRef: buildRef("Archived circle txn", archivedCircleTxnId),
    }),
  ).toMatchObject({ ok: false, error: "circle_archived" });

  await t.run((ctx) => ctx.db.patch(grant._id, { status: "revoked", revokedAt: Date.now() }));
  expect(
    await executeMcpWrite(t, grant._id, {
      kind,
      circleRef,
      transactionRef,
    }),
  ).toMatchObject({ ok: false, error: "grant_unavailable" });

  const freshGrant = await createActiveMcpGrant(t, {
    userId: owner.userId,
    circleIds: [f.circleId],
    scopes: READ_WRITE,
    clientId: `${CLIENT_ID}/${clientPrefix}-removed`,
    clientKind: "static",
    redirectUri: REDIRECT_URI,
  });
  await t.run(async (ctx) => {
    const membership = await ctx.db
      .query("members")
      .withIndex("by_circle_and_user", (q) =>
        q.eq("circleId", f.circleId).eq("userId", owner.userId),
      )
      .unique();
    if (!membership) throw new Error("owner membership missing");
    await ctx.db.patch(membership._id, { status: "removed" });
  });
  expect(
    await executeMcpWrite(t, freshGrant._id, {
      kind,
      circleRef,
      transactionRef,
    }),
  ).toMatchObject({ ok: false, error: "circle_inaccessible" });

  await t.run(async (ctx) => {
    const histories = await ctx.db.query("histories").collect();
    expect(histories.filter((event) => event.entityId === txnId)).toHaveLength(1);
  });
}

describe("MCP archive_transaction write", () => {
  it("archives by recorder and owner, excludes totals, records history, and notifies another Member", async () => {
    const t = convexTest(schema, modules);
    const owner = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "owner@example.com", displayName: "Circle Owner" }),
    );
    const f = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Shared" }));
    const member = await t.run((ctx) =>
      addMember(ctx, f.circleId, "recorder@example.com", "Recorder Member"),
    );
    const memberTxnId = await t.run((ctx) =>
      seedTransaction(ctx, f, {
        title: "Member lunch",
        amountMinorUnits: 1_500,
        date: "2026-06-01",
        recordedByMemberId: member.memberId,
      }),
    );
    const ownerGrant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [f.circleId],
      scopes: READ_WRITE,
      clientId: CLIENT_ID,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    const circleRef = buildRef("Shared", f.circleId);
    const memberTxnRef = buildRef("Member lunch", memberTxnId);

    const ledgerBefore = await executeMcpRead(t, ownerGrant._id, {
      kind: "get_monthly_ledger",
      circleRef,
      month: "2026-06",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(ledgerBefore).toMatchObject({
      ok: true,
      value: { totals: { expenseMinor: 1_500 } },
    });
    const dashboardBefore = await executeMcpRead(t, ownerGrant._id, {
      kind: "get_dashboard",
      circleRef,
      month: "2026-06",
    });
    expect(dashboardBefore).toMatchObject({
      ok: true,
      value: { totals: { expenseMinor: 1_500 } },
    });

    const archived = await mutateAndDrain(t, () =>
      executeMcpWrite(t, ownerGrant._id, {
        kind: "archive_transaction",
        circleRef,
        transactionRef: memberTxnRef,
      }),
    );
    expect(archived).toMatchObject({
      ok: true,
      value: { transaction: { status: "archived" } },
    });

    const ledgerAfter = await executeMcpRead(t, ownerGrant._id, {
      kind: "get_monthly_ledger",
      circleRef,
      month: "2026-06",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(ledgerAfter).toMatchObject({
      ok: true,
      value: { totals: { expenseMinor: 0 } },
    });
    const dashboardAfter = await executeMcpRead(t, ownerGrant._id, {
      kind: "get_dashboard",
      circleRef,
      month: "2026-06",
    });
    expect(dashboardAfter).toMatchObject({
      ok: true,
      value: { totals: { expenseMinor: 0 } },
    });

    expect(
      await executeMcpWrite(t, ownerGrant._id, {
        kind: "update_transaction",
        circleRef,
        transactionRef: memberTxnRef,
        title: "Blocked edit",
      }),
    ).toMatchObject({ ok: false, error: "transaction_inaccessible" });

    await t.run(async (ctx) => {
      const histories = await ctx.db.query("histories").collect();
      expect(
        histories.some((event) => event.entityId === memberTxnId && event.action === "archived"),
      ).toBe(true);
      expect(await listNotificationsForUser(ctx, member.user._id)).toHaveLength(1);
      expect(await listNotificationsForUser(ctx, owner.userId)).toHaveLength(0);
    });

    const memberGrant = await createActiveMcpGrant(t, {
      userId: member.user._id,
      circleIds: [f.circleId],
      scopes: READ_WRITE,
      clientId: `${CLIENT_ID}/member-archive`,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    const ownTxnId = await t.run((ctx) =>
      seedTransaction(ctx, f, {
        title: "Own coffee",
        recordedByMemberId: member.memberId,
      }),
    );
    const ownArchived = await executeMcpWrite(t, memberGrant._id, {
      kind: "archive_transaction",
      circleRef,
      transactionRef: buildRef("Own coffee", ownTxnId),
    });
    expect(ownArchived).toMatchObject({ ok: true });
    await t.run(async (ctx) => {
      expect(await listNotificationsForUser(ctx, member.user._id)).toHaveLength(1);
    });
  });

  it("rejects unrelated Member, repeated archive, and invalid states without partial writes", async () => {
    await runLifecycleWriteDenialSuite("archive_transaction");
  });
});

describe("MCP restore_transaction write", () => {
  it("restores archived Transaction, returns totals, records history, and notifies another Member", async () => {
    const t = convexTest(schema, modules);
    const { owner, f, member, grant, circleRef, transactionRef, txnId } = await seedUpdateFixture(
      t,
      { status: "archived" },
    );
    await t.run((ctx) =>
      seedTransaction(ctx, f, {
        title: "Other txn",
        amountMinorUnits: 500,
        date: "2026-06-02",
      }),
    );

    const ledgerBefore = await executeMcpRead(t, grant._id, {
      kind: "get_monthly_ledger",
      circleRef,
      month: "2026-06",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(ledgerBefore).toMatchObject({
      ok: true,
      value: { totals: { expenseMinor: 500 } },
    });

    const restored = await executeMcpWrite(t, grant._id, {
      kind: "restore_transaction",
      circleRef,
      transactionRef,
    });
    expect(restored).toMatchObject({
      ok: true,
      value: { transaction: { status: "active" } },
    });

    const ledgerAfter = await executeMcpRead(t, grant._id, {
      kind: "get_monthly_ledger",
      circleRef,
      month: "2026-06",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(ledgerAfter).toMatchObject({
      ok: true,
      value: { totals: { expenseMinor: 3_000 } },
    });

    await t.run(async (ctx) => {
      const histories = await ctx.db.query("histories").collect();
      expect(
        histories.some((event) => event.entityId === txnId && event.action === "restored"),
      ).toBe(true);
    });

    const memberTxnId = await t.run((ctx) =>
      seedTransaction(ctx, f, {
        title: "Member archived",
        status: "archived",
        recordedByMemberId: member.memberId,
      }),
    );
    const memberTxnRef = buildRef("Member archived", memberTxnId);
    await mutateAndDrain(t, () =>
      executeMcpWrite(t, grant._id, {
        kind: "restore_transaction",
        circleRef,
        transactionRef: memberTxnRef,
      }),
    );
    await t.run(async (ctx) => {
      expect(await listNotificationsForUser(ctx, member.user._id)).toHaveLength(1);
      expect(await listNotificationsForUser(ctx, owner.userId)).toHaveLength(0);
    });

    const memberGrant = await createActiveMcpGrant(t, {
      userId: member.user._id,
      circleIds: [f.circleId],
      scopes: READ_WRITE,
      clientId: `${CLIENT_ID}/member-restore`,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    const recorderTxnId = await t.run((ctx) =>
      seedTransaction(ctx, f, {
        title: "Recorder archived",
        status: "archived",
        recordedByMemberId: member.memberId,
      }),
    );
    const recorderRestored = await executeMcpWrite(t, memberGrant._id, {
      kind: "restore_transaction",
      circleRef,
      transactionRef: buildRef("Recorder archived", recorderTxnId),
    });
    expect(recorderRestored).toMatchObject({
      ok: true,
      value: { transaction: { status: "active" } },
    });
  });

  it("rejects unrelated Member, repeated restore, active Transaction, and invalid states", async () => {
    await runLifecycleWriteDenialSuite("restore_transaction");
  });
});

describe("MCP create_category write", () => {
  it("creates expense and income categories with history and activation milestone", async () => {
    const t = convexTest(schema, modules);
    const { owner, f, grant, circleRef } = await seedMcpWriteFixture(t);

    const expense = await executeMcpWrite(t, grant._id, {
      kind: "create_category",
      circleRef,
      name: "Coffee",
      type: "expense",
      color: "teal",
    });
    expect(expense).toMatchObject({ ok: true });
    if (!expense.ok) {
      throw new Error("expected expense category create");
    }
    expect(expense.value.category).toMatchObject({
      name: "Coffee",
      type: "expense",
      color: "teal",
      status: "active",
      canEditFields: true,
    });
    expect(expense.value.ref).toBe(expense.value.category.ref);

    const income = await executeMcpWrite(t, grant._id, {
      kind: "create_category",
      circleRef,
      name: "Coffee",
      type: "income",
      color: "amber",
    });
    expect(income).toMatchObject({ ok: true });

    await t.run(async (ctx) => {
      const activation = await ctx.db
        .query("userActivation")
        .withIndex("by_user", (q) => q.eq("userId", owner.userId))
        .unique();
      expect(activation?.categoryCreatedAt).toEqual(expect.any(Number));
      const histories = await ctx.db.query("histories").collect();
      expect(
        histories.some(
          (event) => event.action === "created" && event.changes.some((c) => c.field === "name"),
        ),
      ).toBe(true);
      const sameNameCount = await ctx.db
        .query("categories")
        .withIndex("by_circle_type_name", (q) =>
          q.eq("circleId", f.circleId).eq("type", "expense").eq("nameLower", "coffee"),
        )
        .collect();
      expect(sameNameCount).toHaveLength(1);
    });
  });

  it("rejects duplicate names case-insensitively, archived name reservation, invalid colors, lifecycle, scope, and grant failures", async () => {
    const t = convexTest(schema, modules);
    const { owner, f, member, grant, memberGrant, circleRef } = await seedMcpWriteFixture(t, {
      includeMemberGrant: true,
    });
    const other = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Other" }));
    await t.run((ctx) =>
      makeCategory(ctx, f.circleId, {
        name: "Old snacks",
        status: "archived",
        creatorUserId: owner.userId,
      }),
    );
    const incomplete = await t.run((ctx) =>
      seedOwnedCircle(ctx, owner.owner, { name: "Draft", setupCompletedAt: null }),
    );
    const archivedCircle = await t.run((ctx) =>
      seedOwnedCircle(ctx, owner.owner, { name: "Archived", archived: true }),
    );
    const base = {
      kind: "create_category" as const,
      circleRef,
      name: "Snacks",
      type: "expense" as const,
      color: "teal",
    };

    expect(await executeMcpWrite(t, grant._id, base)).toMatchObject({ ok: true });
    const countAfterSuccess = await t.run(async (ctx) =>
      ctx.db
        .query("categories")
        .withIndex("by_circle", (q) => q.eq("circleId", f.circleId))
        .collect(),
    );
    expect(await executeMcpWrite(t, grant._id, { ...base, name: "snacks" })).toMatchObject({
      ok: false,
      error: "category_name_duplicate",
    });
    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        name: "Old snacks",
      }),
    ).toMatchObject({
      ok: false,
      error: "category_name_duplicate",
    });
    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        name: "Fresh",
        color: "chartreuse",
      }),
    ).toMatchObject({
      ok: false,
      error: "validation_failed",
    });
    expect(await executeMcpWrite(t, grant._id, { ...base, name: "   " })).toMatchObject({
      ok: false,
      error: "validation_failed",
    });
    expect(
      await executeMcpWrite(t, grant._id, { ...base, circleRef: "not-a-circle" }),
    ).toMatchObject({ ok: false, error: "circle_inaccessible" });
    expect(
      await executeMcpWrite(t, grant._id, {
        ...base,
        circleRef: buildRef("Other", other.circleId),
        name: "Other circle cat",
      }),
    ).toMatchObject({ ok: false, error: "circle_inaccessible" });
    await t.run(async (ctx) => {
      const countAfterFailure = await ctx.db
        .query("categories")
        .withIndex("by_circle", (q) => q.eq("circleId", f.circleId))
        .collect();
      expect(countAfterFailure).toHaveLength(countAfterSuccess.length);
    });
    expect(await executeMcpWrite(t, grant._id, base, ["pocketcircle:read"])).toMatchObject({
      ok: false,
      error: "insufficient_scope",
    });
    expect(
      await executeMcpWrite(t, memberGrant._id, { ...base, name: "Member cat" }),
    ).toMatchObject({ ok: true });

    const readOnlyGrant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [f.circleId],
      scopes: ["pocketcircle:read"],
      clientId: CLIENT_ID,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    expect(await executeMcpWrite(t, readOnlyGrant._id, base, READ_WRITE)).toMatchObject({
      ok: false,
      error: "insufficient_scope",
    });

    const incompleteGrant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [incomplete.circleId],
      scopes: READ_WRITE,
      clientId: CLIENT_ID,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    expect(
      await executeMcpWrite(t, incompleteGrant._id, {
        ...base,
        circleRef: buildRef("Draft", incomplete.circleId),
        name: "Draft cat",
      }),
    ).toMatchObject({ ok: false, error: "circle_setup_incomplete" });

    const archivedGrant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [archivedCircle.circleId],
      scopes: READ_WRITE,
      clientId: CLIENT_ID,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    expect(
      await executeMcpWrite(t, archivedGrant._id, {
        ...base,
        circleRef: buildRef("Archived", archivedCircle.circleId),
        name: "Archived cat",
      }),
    ).toMatchObject({ ok: false, error: "circle_archived" });

    await t.run((ctx) => ctx.db.patch(grant._id, { status: "revoked", revokedAt: Date.now() }));
    expect(await executeMcpWrite(t, grant._id, { ...base, name: "Revoked cat" })).toMatchObject({
      ok: false,
      error: "grant_unavailable",
    });

    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", f.circleId).eq("userId", member.user._id),
        )
        .unique();
      if (!membership) throw new Error("member missing");
      await ctx.db.patch(membership._id, { status: "removed" });
    });
    expect(
      await executeMcpWrite(t, memberGrant._id, { ...base, name: "Removed cat" }),
    ).toMatchObject({ ok: false, error: "circle_inaccessible" });
  });
});

describe("MCP update_category write", () => {
  async function seedUpdateCategoryFixture(t: ReturnType<typeof convexTest>) {
    const base = await seedMcpWriteFixture(t, {
      includeMemberGrant: true,
      ownerEmail: "cat-updater@example.com",
    });
    const memberCategoryId = await t.run((ctx) =>
      makeCategory(ctx, base.f.circleId, {
        name: "Member Cat",
        creatorUserId: base.member.user._id,
      }),
    );
    const archivedCategoryId = await t.run((ctx) =>
      makeCategory(ctx, base.f.circleId, {
        name: "Archived Cat",
        status: "archived",
        creatorUserId: base.owner.userId,
      }),
    );
    return {
      ...base,
      ownerCategoryRef: buildRef("Groceries", base.f.groceriesId),
      memberCategoryRef: buildRef("Member Cat", memberCategoryId),
      archivedCategoryRef: buildRef("Archived Cat", archivedCategoryId),
    };
  }

  it("updates name and color with history, allows no-op, and case-only rename", async () => {
    const t = convexTest(schema, modules);
    const { f, grant, circleRef, ownerCategoryRef } = await seedUpdateCategoryFixture(t);

    const renamed = await executeMcpWrite(t, grant._id, {
      kind: "update_category",
      circleRef,
      categoryRef: ownerCategoryRef,
      name: "Food",
      color: "amber",
    });
    expect(renamed).toMatchObject({
      ok: true,
      value: { category: { name: "Food", color: "amber" } },
    });

    const noop = await executeMcpWrite(t, grant._id, {
      kind: "update_category",
      circleRef,
      categoryRef: ownerCategoryRef,
      name: "Food",
      color: "amber",
    });
    expect(noop).toMatchObject({ ok: true });

    const caseOnly = await executeMcpWrite(t, grant._id, {
      kind: "update_category",
      circleRef,
      categoryRef: ownerCategoryRef,
      name: "FOOD",
    });
    expect(caseOnly).toMatchObject({ ok: true, value: { category: { name: "FOOD" } } });

    await t.run(async (ctx) => {
      const histories = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", f.groceriesId))
        .collect();
      expect(histories.some((event) => event.action === "edited")).toBe(true);
      const noopCount = histories.filter((event) => event.action === "edited").length;
      expect(noopCount).toBe(2);
    });
  });

  it("rejects owner editing another creator's category, archived category, duplicate rename, invalid color, and access failures", async () => {
    const t = convexTest(schema, modules);
    const {
      owner,
      f,
      member,
      grant,
      memberGrant,
      circleRef,
      ownerCategoryRef,
      memberCategoryRef,
      archivedCategoryRef,
    } = await seedUpdateCategoryFixture(t);
    const otherCategoryId = await t.run((ctx) =>
      makeCategory(ctx, f.circleId, { name: "Dining", creatorUserId: owner.userId }),
    );

    expect(
      await executeMcpWrite(t, grant._id, {
        kind: "update_category",
        circleRef,
        categoryRef: memberCategoryRef,
        name: "Owner hijack",
      }),
    ).toMatchObject({ ok: false, error: "category_inaccessible" });

    expect(
      await executeMcpWrite(t, memberGrant._id, {
        kind: "update_category",
        circleRef,
        categoryRef: memberCategoryRef,
        name: "Member rename",
        color: "teal",
      }),
    ).toMatchObject({ ok: true });

    expect(
      await executeMcpWrite(t, grant._id, {
        kind: "update_category",
        circleRef,
        categoryRef: archivedCategoryRef,
        name: "Revive",
      }),
    ).toMatchObject({ ok: false, error: "category_inaccessible" });

    expect(
      await executeMcpWrite(t, memberGrant._id, {
        kind: "update_category",
        circleRef,
        categoryRef: memberCategoryRef,
        name: "Dining",
      }),
    ).toMatchObject({ ok: false, error: "category_name_duplicate" });

    expect(
      await executeMcpWrite(t, grant._id, {
        kind: "update_category",
        circleRef,
        categoryRef: buildRef("Dining", otherCategoryId),
        color: "not-a-color",
      }),
    ).toMatchObject({ ok: false, error: "validation_failed" });

    expect(
      await executeMcpWrite(t, grant._id, {
        kind: "update_category",
        circleRef,
        categoryRef: "not-a-category",
      }),
    ).toMatchObject({ ok: false, error: "category_inaccessible" });

    expect(
      await executeMcpWrite(
        t,
        grant._id,
        {
          kind: "update_category",
          circleRef,
          categoryRef: memberCategoryRef,
          name: "Scope test",
        },
        ["pocketcircle:read"],
      ),
    ).toMatchObject({ ok: false, error: "insufficient_scope" });

    await t.run((ctx) => ctx.db.patch(grant._id, { status: "revoked", revokedAt: Date.now() }));
    expect(
      await executeMcpWrite(t, grant._id, {
        kind: "update_category",
        circleRef,
        categoryRef: memberCategoryRef,
        name: "Revoked update",
      }),
    ).toMatchObject({ ok: false, error: "grant_unavailable" });

    const freshGrant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [f.circleId],
      scopes: READ_WRITE,
      clientId: `${CLIENT_ID}/update-lifecycle`,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    const incomplete = await t.run((ctx) =>
      seedOwnedCircle(ctx, owner.owner, { name: "Draft", setupCompletedAt: null }),
    );
    const archivedCircle = await t.run((ctx) =>
      seedOwnedCircle(ctx, owner.owner, { name: "Archived", archived: true }),
    );
    const other = await t.run((ctx) => seedOwnedFixture(ctx, owner.owner, { name: "Other" }));
    const incompleteCategoryId = await t.run((ctx) =>
      makeCategory(ctx, incomplete.circleId, {
        name: "Draft Cat",
        creatorUserId: owner.userId,
      }),
    );
    const archivedCategoryInCircleId = await t.run((ctx) =>
      makeCategory(ctx, archivedCircle.circleId, {
        name: "Archived Circle Cat",
        creatorUserId: owner.userId,
      }),
    );
    const historyBefore = await t.run(async (ctx) =>
      ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", f.groceriesId))
        .collect(),
    );
    expect(
      await executeMcpWrite(t, freshGrant._id, {
        kind: "update_category",
        circleRef: buildRef("Other", other.circleId),
        categoryRef: ownerCategoryRef,
        name: "Deselected update",
      }),
    ).toMatchObject({ ok: false, error: "circle_inaccessible" });
    const incompleteGrant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [incomplete.circleId],
      scopes: READ_WRITE,
      clientId: `${CLIENT_ID}/update-incomplete`,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    expect(
      await executeMcpWrite(t, incompleteGrant._id, {
        kind: "update_category",
        circleRef: buildRef("Draft", incomplete.circleId),
        categoryRef: buildRef("Draft Cat", incompleteCategoryId),
        name: "Draft update",
      }),
    ).toMatchObject({ ok: false, error: "circle_setup_incomplete" });
    const archivedGrant = await createActiveMcpGrant(t, {
      userId: owner.userId,
      circleIds: [archivedCircle.circleId],
      scopes: READ_WRITE,
      clientId: `${CLIENT_ID}/update-archived`,
      clientKind: "static",
      redirectUri: REDIRECT_URI,
    });
    expect(
      await executeMcpWrite(t, archivedGrant._id, {
        kind: "update_category",
        circleRef: buildRef("Archived", archivedCircle.circleId),
        categoryRef: buildRef("Archived Circle Cat", archivedCategoryInCircleId),
        name: "Archived circle update",
      }),
    ).toMatchObject({ ok: false, error: "circle_archived" });
    expect(
      await executeMcpWrite(t, freshGrant._id, {
        kind: "update_category",
        circleRef,
        categoryRef: memberCategoryRef,
        name: "Owner hijack retry",
      }),
    ).toMatchObject({ ok: false, error: "category_inaccessible" });
    await t.run(async (ctx) => {
      const historyAfter = await ctx.db
        .query("histories")
        .withIndex("by_entity", (q) => q.eq("entityId", f.groceriesId))
        .collect();
      expect(historyAfter).toHaveLength(historyBefore.length);
    });

    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", f.circleId).eq("userId", member.user._id),
        )
        .unique();
      if (!membership) throw new Error("member missing");
      await ctx.db.patch(membership._id, { status: "removed", removedAt: Date.now() });
    });
    expect(
      await executeMcpWrite(t, memberGrant._id, {
        kind: "update_category",
        circleRef,
        categoryRef: memberCategoryRef,
        name: "Removed rename",
      }),
    ).toMatchObject({ ok: false, error: "circle_inaccessible" });
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", f.circleId).eq("userId", member.user._id),
        )
        .unique();
      if (!membership) throw new Error("member missing");
      await ctx.db.patch(membership._id, { status: "active", removedAt: undefined });
    });
    expect(
      await executeMcpWrite(t, memberGrant._id, {
        kind: "update_category",
        circleRef,
        categoryRef: memberCategoryRef,
        name: "Rejoined rename",
      }),
    ).toMatchObject({ ok: true, value: { category: { name: "Rejoined rename" } } });
  });
});
