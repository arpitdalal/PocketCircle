import { sha256Hex, verifyMcpWorkerAssertion } from "@pocketcircle/domain";
import { httpRouter } from "convex/server";
import { z } from "zod";
import { internal } from "./_generated/api.js";
import type { ActionCtx } from "./_generated/server.js";
import { httpAction } from "./_generated/server.js";
import { authComponent, createAuth } from "./auth.js";

// Mounts the Better Auth HTTP routes (e.g. /api/auth/callback/google) on this
// deployment's site URL (ADR 0002). SPA mode has no app server, so auth is
// served entirely by Convex.
const http = httpRouter();
// `cors: true` makes the auth routes emit Access-Control-* headers for the app
// origin (the SPA runs on a different origin than this *.convex.site deployment).
// Allowed origins are derived from Better Auth's trustedOrigins (see auth.ts).
authComponent.registerRoutes(http, createAuth, { cors: true });

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const WORKER_AUTH_PREFIX = "PocketCircleWorker ";

/** Sentinel distinguishing "assertion rejected" from a legitimately empty/`{}` body. */
const WORKER_AUTH_FAILED = Symbol("mcp_worker_auth_failed");

/**
 * Verifies the Worker's signed per-request service assertion (#318):
 * Authorization: `PocketCircleWorker <token>`, where the token's method/path/
 * body digest must match this exact request, the signature must be valid and
 * unexpired, and the nonce must be unused (replay protection). Never trusts
 * anything else about the request — this is the only Worker→Convex trust
 * boundary for the MCP bridge routes below.
 */
async function verifyWorkerRequest(ctx: ActionCtx, request: Request, path: string) {
  const secret = process.env.MCP_WORKER_HMAC_SECRET;
  if (!secret) {
    return WORKER_AUTH_FAILED;
  }
  const authHeader = request.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith(WORKER_AUTH_PREFIX)) {
    return WORKER_AUTH_FAILED;
  }
  const token = authHeader.slice(WORKER_AUTH_PREFIX.length);
  const bodyText = await request.text();
  const assertion = await verifyMcpWorkerAssertion(token, secret, Date.now());
  if (!assertion) {
    return WORKER_AUTH_FAILED;
  }
  const bodySha256 = await sha256Hex(bodyText);
  if (
    assertion.method !== request.method ||
    assertion.path !== path ||
    assertion.bodySha256 !== bodySha256
  ) {
    return WORKER_AUTH_FAILED;
  }
  // Reuse the exact assertion outside its intended request → 401, not just a
  // stale signature: consumeWorkerNonce fails closed on any prior use.
  const nonceIsFresh = await ctx.runMutation(internal.mcpApproval.consumeWorkerNonce, {
    nonce: assertion.nonce,
    expiresAt: assertion.exp,
  });
  if (!nonceIsFresh) {
    return WORKER_AUTH_FAILED;
  }
  if (bodyText.length === 0) {
    return {};
  }
  try {
    return JSON.parse(bodyText);
  } catch {
    return WORKER_AUTH_FAILED;
  }
}

const redeemApprovalBodySchema = z.object({ token: z.string() });

http.route({
  path: "/mcp/redeem-approval",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await verifyWorkerRequest(ctx, request, "/mcp/redeem-approval");
    if (body === WORKER_AUTH_FAILED) {
      return jsonResponse(401, { ok: false, error: "unauthorized" });
    }
    const parsedBody = redeemApprovalBodySchema.safeParse(body);
    if (!parsedBody.success) {
      return jsonResponse(400, { ok: false, error: "invalid_body" });
    }
    const result = await ctx.runMutation(internal.mcpApproval.redeemApprovalToken, {
      token: parsedBody.data.token,
    });
    return jsonResponse(result.ok ? 200 : 400, result);
  }),
});

const activateGrantBodySchema = z.object({
  grantId: z.string(),
  workerGrantId: z.string(),
  principalId: z.string(),
});

http.route({
  path: "/mcp/activate-grant",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await verifyWorkerRequest(ctx, request, "/mcp/activate-grant");
    if (body === WORKER_AUTH_FAILED) {
      return jsonResponse(401, { ok: false, error: "unauthorized" });
    }
    const parsedBody = activateGrantBodySchema.safeParse(body);
    if (!parsedBody.success) {
      return jsonResponse(400, { ok: false, error: "invalid_body" });
    }
    const result = await ctx.runMutation(
      internal.mcpApproval.activateGrantFromWorker,
      parsedBody.data,
    );
    return jsonResponse(result.ok ? 200 : 400, result);
  }),
});

const validateGrantBodySchema = z.object({
  grantId: z.string(),
  principalId: z.string(),
  requestedScopes: z.array(z.string()),
});

http.route({
  path: "/mcp/validate-grant",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await verifyWorkerRequest(ctx, request, "/mcp/validate-grant");
    if (body === WORKER_AUTH_FAILED) {
      return jsonResponse(401, { ok: false, error: "unauthorized" });
    }
    const parsedBody = validateGrantBodySchema.safeParse(body);
    if (!parsedBody.success) {
      return jsonResponse(400, { ok: false, error: "invalid_body" });
    }
    const result = await ctx.runQuery(internal.mcpApproval.validateActiveGrant, parsedBody.data);
    return jsonResponse(result.ok ? 200 : 400, result);
  }),
});

export default http;
