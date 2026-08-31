import {
  MCP_WORKER_ASSERTION_TTL_MS,
  type McpOperationBody,
  type McpWorkerAssertionPayload,
  parseMcpWorkerPrivateJwk,
  sha256Hex,
  signMcpWorkerAssertion,
} from "@pocketcircle/domain";
import { z } from "zod";
import type { Env } from "./env.js";

const MCP_WORKER_AUD = "pocketcircle:mcp-worker";

export type BridgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; retryable: boolean };

function isLoopbackHostname(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function validateConvexSiteUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "https:") {
      return url.origin;
    }
    if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
      return url.origin;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// Signs a per-request Worker service assertion (method/path/body digest, short
// TTL, single-use nonce) and calls the matching Convex HTTP route. Must match
// `verifyWorkerRequest` in packages/convex/convex/http.ts exactly.
async function signedConvexFetch(env: Env, path: string, body: unknown) {
  const origin = validateConvexSiteUrl(env.CONVEX_SITE_URL);
  if (!origin) {
    throw new Error("Invalid CONVEX_SITE_URL: must be HTTPS or local loopback");
  }
  const bodyText = JSON.stringify(body);
  const privateJwk = parseMcpWorkerPrivateJwk(env.MCP_WORKER_SIGNING_PRIVATE_JWK);
  if (!privateJwk) {
    throw new Error("Invalid MCP_WORKER_SIGNING_PRIVATE_JWK");
  }
  const now = Date.now();
  const payload: McpWorkerAssertionPayload = {
    aud: MCP_WORKER_AUD,
    method: "POST",
    path,
    bodySha256: await sha256Hex(bodyText),
    iat: now,
    exp: now + MCP_WORKER_ASSERTION_TTL_MS,
    nonce: crypto.randomUUID(),
  };
  const assertion = await signMcpWorkerAssertion(payload, privateJwk);
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `PocketCircleWorker ${assertion}`,
    },
    body: bodyText,
  });
}

const failureSchema = z.object({ ok: z.literal(false), error: z.string() });

function bridgeFailure(response: Response, error: string, fallback: string, definitive: boolean) {
  if (response.status === 400 && definitive) {
    return { ok: false as const, error, retryable: false };
  }
  return { ok: false as const, error: fallback, retryable: true };
}

export const redeemApprovalValueSchema = z.object({
  grantId: z.string(),
  principalId: z.string(),
  clientId: z.string(),
  redirectUri: z.string(),
  resource: z.string(),
  scopes: z.array(z.string()),
  allowedCircleIds: z.array(z.string()),
  handoffId: z.string(),
});

const redeemApprovalResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    value: redeemApprovalValueSchema,
  }),
  failureSchema,
]);

export type RedeemApprovalValue = Extract<
  z.infer<typeof redeemApprovalResponseSchema>,
  { ok: true }
>["value"];

export async function redeemApproval(
  env: Env,
  args: { token: string; handoffId: string; claimId: string },
) {
  try {
    const response = await signedConvexFetch(env, "/mcp/redeem-approval", args);
    const parsed = redeemApprovalResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return {
        ok: false as const,
        error: "redeem_approval_bad_response",
        retryable: true,
      };
    }
    if (!response.ok) {
      const error = parsed.data.ok ? "redeem_approval_http_error" : parsed.data.error;
      return bridgeFailure(response, error, "redeem_approval_unavailable", !parsed.data.ok);
    }
    return parsed.data.ok
      ? { ok: true as const, value: parsed.data.value }
      : {
          ok: false as const,
          error: "redeem_approval_bad_response",
          retryable: true,
        };
  } catch {
    return {
      ok: false as const,
      error: "redeem_approval_request_failed",
      retryable: true,
    };
  }
}

const simpleResponseSchema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  failureSchema,
]);

async function callSimpleBridgeEndpoint(env: Env, path: string, body: unknown) {
  try {
    const response = await signedConvexFetch(env, path, body);
    const parsed = simpleResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { ok: false as const, error: `${path}_bad_response`, retryable: true };
    }
    if (!response.ok) {
      const error = parsed.data.ok ? `${path}_http_error` : parsed.data.error;
      return bridgeFailure(response, error, `${path}_unavailable`, !parsed.data.ok);
    }
    return parsed.data.ok
      ? { ok: true as const, value: true as const }
      : { ok: false as const, error: `${path}_bad_response`, retryable: true };
  } catch {
    return { ok: false as const, error: `${path}_request_failed`, retryable: true };
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

const operationResponseSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  failureSchema,
]);

export async function executeMcpOperation<T>(
  env: Env,
  args: McpOperationBody,
  schema: z.ZodType<T>,
) {
  try {
    const response = await signedConvexFetch(env, "/mcp/operation", args);
    const parsed = operationResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { ok: false, error: "operation_bad_response", retryable: true };
    }
    if (!response.ok) {
      const error = parsed.data.ok ? "operation_http_error" : parsed.data.error;
      return bridgeFailure(response, error, "operation_unavailable", !parsed.data.ok);
    }
    if (!parsed.data.ok) {
      return { ok: false, error: parsed.data.error, retryable: false };
    }
    const parsedValue = schema.safeParse(parsed.data.value);
    if (!parsedValue.success) {
      return { ok: false, error: "operation_bad_payload", retryable: false };
    }
    return { ok: true, value: parsedValue.data };
  } catch {
    return { ok: false, error: "operation_request_failed", retryable: true };
  }
}
