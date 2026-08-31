import {
  MCP_APPROVAL_TTL_MS,
  MCP_PENDING_ACTIVATION_TTL_MS,
  MCP_PENDING_GRANT_TTL_MS,
  MCP_RESOURCE_URI,
  MCP_WORKER_ASSERTION_TTL_MS,
  type McpApprovalPayload,
  type McpWorkerAssertionPayload,
  parseMcpWorkerJwks,
  parseMcpWorkerPrivateJwk,
  sha256Hex,
  signMcpWorkerAssertion,
} from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mutateAndDrain } from "../test/mutateAndDrain.js";
import { seedPersonalCircleOwner } from "../test/seed.js";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
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

beforeEach(() => {
  vi.stubEnv("MCP_WORKER_HMAC_SECRET", SECRET);
  vi.stubEnv("MCP_WORKER_HMAC_SECRET_PREVIOUS", "");
  vi.stubEnv("MCP_WORKER_VERIFYING_JWKS", PUBLIC_JWKS_JSON);
});

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
});
