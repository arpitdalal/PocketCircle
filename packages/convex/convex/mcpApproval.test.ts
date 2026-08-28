import {
  MCP_APPROVAL_TTL_MS,
  MCP_RESOURCE_URI,
  type McpApprovalPayload,
  type McpWorkerAssertionPayload,
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
import { createPendingMcpGrant } from "./mcpGrant.js";
import { generateOpaqueToken } from "./opaqueToken.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");
const SECRET = "test-mcp-worker-secret";
const READ_WRITE = ["pocketcircle:read", "pocketcircle:write"];
const CLIENT_ID = "https://client.example/client.json";
const REDIRECT_URI = "https://client.example/callback";

beforeEach(() => {
  vi.stubEnv("MCP_WORKER_HMAC_SECRET", SECRET);
});

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

    const result = await t.mutation(internal.mcpApproval.redeemApprovalToken, { token });
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

  it("rejects a second redeem of the same token as consumed", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const { token } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
    });

    await t.mutation(internal.mcpApproval.redeemApprovalToken, { token });
    expect(await t.mutation(internal.mcpApproval.redeemApprovalToken, { token })).toEqual({
      ok: false,
      error: "consumed",
    });
  });

  it("lets exactly one of two concurrent redeems win", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const { token } = await seedApprovalToken(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
    });

    const [first, second] = await Promise.all([
      t.mutation(internal.mcpApproval.redeemApprovalToken, { token }),
      t.mutation(internal.mcpApproval.redeemApprovalToken, { token }),
    ]);
    const outcomes = [first, second];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    expect(outcomes.filter((r) => !r.ok)).toEqual([{ ok: false, error: "consumed" }]);
  });

  it("rejects a token that doesn't exist", async () => {
    const t = convexTest(schema, modules);
    expect(
      await t.mutation(internal.mcpApproval.redeemApprovalToken, { token: "unknown-token" }),
    ).toEqual({
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
    expect(await t.mutation(internal.mcpApproval.redeemApprovalToken, { token })).toEqual({
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
    expect(
      await t.mutation(internal.mcpApproval.redeemApprovalToken, { token: forgedToken }),
    ).toEqual({
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
    expect(await t.mutation(internal.mcpApproval.redeemApprovalToken, { token })).toEqual({
      ok: false,
      error: "not_found",
    });
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
    overrides: Partial<McpWorkerAssertionPayload> & { secret?: string } = {},
  ) {
    const bodyText = JSON.stringify(body);
    const now = Date.now();
    const assertion: McpWorkerAssertionPayload = {
      aud: "pocketcircle:mcp-worker",
      method: "POST",
      path,
      bodySha256: await sha256Hex(bodyText),
      iat: now,
      exp: now + 60_000,
      nonce: `nonce-${Math.random()}`,
      ...overrides,
    };
    const token = await signMcpWorkerAssertion(assertion, overrides.secret ?? SECRET);
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

  it("rejects a Worker assertion signed with the wrong secret", async () => {
    const t = convexTest(schema, modules);
    const init = await workerRequestInit(
      "/mcp/redeem-approval",
      { token: "x" },
      { secret: "wrong-secret" },
    );
    expect((await t.fetch("/mcp/redeem-approval", init)).status).toBe(401);
  });

  it("fails closed when MCP_WORKER_HMAC_SECRET is unset", async () => {
    const t = convexTest(schema, modules);
    const init = await workerRequestInit("/mcp/redeem-approval", { token: "x" });
    vi.stubEnv("MCP_WORKER_HMAC_SECRET", "");
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
      await workerRequestInit("/mcp/redeem-approval", { token }),
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
});
