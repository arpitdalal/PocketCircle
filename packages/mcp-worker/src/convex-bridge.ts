import {
  type McpWorkerAssertionPayload,
  sha256Hex,
  signMcpWorkerAssertion,
} from "@pocketcircle/domain";
import { z } from "zod";
import type { Env } from "./env.js";

const MCP_WORKER_AUD = "pocketcircle:mcp-worker";
const ASSERTION_TTL_MS = 30_000;

export type BridgeResult<T> = { ok: true; value: T } | { ok: false; error: string };

// Signs a per-request Worker service assertion (method/path/body digest, short
// TTL, single-use nonce) and calls the matching Convex HTTP route. Must match
// `verifyWorkerRequest` in packages/convex/convex/http.ts exactly.
async function signedConvexFetch(env: Env, path: string, body: unknown) {
  const bodyText = JSON.stringify(body);
  const now = Date.now();
  const payload: McpWorkerAssertionPayload = {
    aud: MCP_WORKER_AUD,
    method: "POST",
    path,
    bodySha256: await sha256Hex(bodyText),
    iat: now,
    exp: now + ASSERTION_TTL_MS,
    nonce: crypto.randomUUID(),
  };
  const assertion = await signMcpWorkerAssertion(payload, env.MCP_WORKER_HMAC_SECRET);
  return fetch(`${env.CONVEX_SITE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `PocketCircleWorker ${assertion}`,
    },
    body: bodyText,
  });
}

const failureSchema = z.object({ ok: z.literal(false), error: z.string() });

const redeemApprovalResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    value: z.object({
      grantId: z.string(),
      principalId: z.string(),
      clientId: z.string(),
      redirectUri: z.string(),
      resource: z.string(),
      scopes: z.array(z.string()),
      allowedCircleIds: z.array(z.string()),
      handoffId: z.string(),
    }),
  }),
  failureSchema,
]);

export type RedeemApprovalValue = Extract<
  z.infer<typeof redeemApprovalResponseSchema>,
  { ok: true }
>["value"];

export async function redeemApproval(
  env: Env,
  token: string,
): Promise<BridgeResult<RedeemApprovalValue>> {
  try {
    const response = await signedConvexFetch(env, "/mcp/redeem-approval", { token });
    const parsed = redeemApprovalResponseSchema.safeParse(await response.json());
    if (!parsed.success) return { ok: false, error: "redeem_approval_bad_response" };
    return parsed.data.ok
      ? { ok: true, value: parsed.data.value }
      : { ok: false, error: parsed.data.error };
  } catch {
    return { ok: false, error: "redeem_approval_request_failed" };
  }
}

const simpleResponseSchema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  failureSchema,
]);

async function callSimpleBridgeEndpoint(
  env: Env,
  path: string,
  body: unknown,
): Promise<BridgeResult<true>> {
  try {
    const response = await signedConvexFetch(env, path, body);
    const parsed = simpleResponseSchema.safeParse(await response.json());
    if (!parsed.success) return { ok: false, error: `${path}_bad_response` };
    return parsed.data.ok ? { ok: true, value: true } : { ok: false, error: parsed.data.error };
  } catch {
    return { ok: false, error: `${path}_request_failed` };
  }
}

export function activateGrant(
  env: Env,
  args: { grantId: string; workerGrantId: string; principalId: string },
) {
  return callSimpleBridgeEndpoint(env, "/mcp/activate-grant", args);
}

export function validateGrant(
  env: Env,
  args: { grantId: string; principalId: string; requestedScopes: readonly string[] },
) {
  return callSimpleBridgeEndpoint(env, "/mcp/validate-grant", args);
}
