/**
 * MCP OAuth handoff + Worker-assertion primitives shared by the Convex consent
 * bridge and the MCP Worker (#318).
 *
 * - Handoff: the Worker signs this when redirecting the browser to the
 *   PocketCircle consent page; Convex only verifies it (`parseMcpHandoff`,
 *   `approveMcpAuthorization`).
 * - Worker assertion: the Worker signs a compact ES256 JWS with its private key
 *   for each server-to-server Convex bridge request. Convex holds only current
 *   and previous public keys, then verifies method/path/body-digest/time/nonce.
 */

import { z } from "zod";

export const MCP_RESOURCE_URI = "https://mcp.pocketcircle.app/mcp";
export const MCP_ISSUER = "https://mcp.pocketcircle.app";
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 900;
export const MCP_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MCP_REFRESH_DURATION_LABEL = "30 days";
export const MCP_HANDOFF_TTL_MS = 10 * 60 * 1000;
export const MCP_APPROVAL_TTL_MS = 5 * 60 * 1000;
export const MCP_REVOCATION_TTL_MS = 5 * 60 * 1000;
export const MCP_PENDING_ACTIVATION_TTL_MS = 20 * 60 * 1000;
export const MCP_WORKER_ASSERTION_TTL_MS = 30_000;
/** Bounded Worker cleanup retries after Convex-first revocation (#330). */
export const MCP_WORKER_CLEANUP_MAX_ATTEMPTS = 5;
export const MCP_WORKER_CLEANUP_INITIAL_BACKOFF_MS = 60_000;
export const MCP_WORKER_CLEANUP_BACKOFF_BASE = 2;
export const MCP_WORKER_CLEANUP_BATCH_SIZE = 32;
/** Abort hung Convex→Worker cleanup fetches so attempts still advance. */
export const MCP_WORKER_CLEANUP_REQUEST_TIMEOUT_MS = 15_000;
const MCP_WORKER_ASSERTION_CLOCK_SKEW_MS = 5_000;
/** Pending grant abandoned if Worker never finishes token exchange in this window. */
export const MCP_PENDING_GRANT_TTL_MS = MCP_APPROVAL_TTL_MS;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importHmacKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Signs `payload` as `base64url(json).base64url(hmac)`. */
async function signCompactToken(payload: unknown, secret: string) {
  const payloadB64 = toBase64Url(textEncoder.encode(JSON.stringify(payload)));
  const key = await importHmacKey(secret);
  const mac = await crypto.subtle.sign("HMAC", key, textEncoder.encode(payloadB64));
  return `${payloadB64}.${toBase64Url(new Uint8Array(mac))}`;
}

/** Verifies the MAC and returns the parsed JSON payload, or null on any tamper/format failure. */
async function verifyCompactToken(token: string, secrets: string | readonly string[]) {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [payloadB64, macB64] = parts;
  if (!payloadB64 || !macB64) {
    return null;
  }
  const candidates = typeof secrets === "string" ? [secrets] : secrets;
  for (const secret of candidates) {
    const verified = await verifyDecodedCompactToken(payloadB64, macB64, secret);
    if (verified !== null) {
      return verified;
    }
  }
  return null;
}

async function verifyDecodedCompactToken(payloadB64: string, macB64: string, secret: string) {
  try {
    const macBytes = fromBase64Url(macB64);
    const payloadJson = textDecoder.decode(fromBase64Url(payloadB64));
    const key = await importHmacKey(secret);
    const valid = await crypto.subtle.verify("HMAC", key, macBytes, textEncoder.encode(payloadB64));
    if (!valid) {
      return null;
    }
    return JSON.parse(payloadJson);
  } catch {
    return null;
  }
}

/** SHA-256 hex digest — used to bind a Worker assertion to its exact request body. */
export async function sha256Hex(input: string) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export const MCP_HANDOFF_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mcpHandoffPayloadSchema = z.object({
  v: z.literal(1),
  handoffId: z.string().min(1),
  clientId: z.string().min(1),
  clientKind: z.union([z.literal("static"), z.literal("cimd")]),
  redirectUri: z.string().min(1),
  resource: z.string().min(1),
  scopes: z.array(z.string()),
  clientName: z.string().optional(),
  clientUri: z.string().optional(),
  logoUri: z.string().optional(),
  iat: z.number(),
  exp: z.number(),
});

export type McpHandoffClientKind = z.infer<typeof mcpHandoffPayloadSchema>["clientKind"];
export type McpHandoffPayload = z.infer<typeof mcpHandoffPayloadSchema>;

/** Signs the Worker's OAuth-authorization handoff envelope for the consent redirect. */
export async function signMcpHandoff(payload: McpHandoffPayload, secret: string) {
  return signCompactToken(payload, secret);
}

/** Verifies signature, shape, and expiry. Fails closed (null) on any mismatch. */
export async function verifyMcpHandoff(
  token: string,
  secrets: string | readonly string[],
  now: number = Date.now(),
) {
  const parsed = await verifyCompactToken(token, secrets);
  const result = mcpHandoffPayloadSchema.safeParse(parsed);
  if (!result.success || result.data.exp <= now) {
    return null;
  }
  return result.data;
}

const base64UrlP256CoordinateSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const mcpWorkerPublicJwkSchema = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: base64UrlP256CoordinateSchema,
    y: base64UrlP256CoordinateSchema,
    kid: z.string().min(1).max(128),
    alg: z.literal("ES256"),
    use: z.literal("sig").optional(),
    key_ops: z.tuple([z.literal("verify")]).optional(),
    ext: z.literal(true).optional(),
  })
  .strict();
const mcpWorkerPrivateJwkSchema = mcpWorkerPublicJwkSchema
  .omit({ key_ops: true })
  .extend({
    d: base64UrlP256CoordinateSchema,
    key_ops: z.tuple([z.literal("sign")]).optional(),
  })
  .strict();
const mcpWorkerJwksSchema = z
  .object({ keys: z.array(mcpWorkerPublicJwkSchema).min(1).max(2) })
  .strict()
  .refine(({ keys }) => new Set(keys.map(({ kid }) => kid)).size === keys.length);

export type McpWorkerPrivateJwk = z.infer<typeof mcpWorkerPrivateJwkSchema>;
export type McpWorkerJwks = z.infer<typeof mcpWorkerJwksSchema>;

export function parseMcpWorkerPrivateJwk(value: string) {
  try {
    const result = mcpWorkerPrivateJwkSchema.safeParse(JSON.parse(value));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function parseMcpWorkerJwks(value: string) {
  try {
    const result = mcpWorkerJwksSchema.safeParse(JSON.parse(value));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

const mcpWorkerAssertionPayloadSchema = z
  .object({
    aud: z.literal("pocketcircle:mcp-worker"),
    method: z.literal("POST"),
    path: z
      .string()
      .regex(
        /^\/mcp\/(redeem-approval|activate-grant|validate-grant|operation|complete-revocation)$/,
      ),
    bodySha256: z.string().regex(/^[0-9a-f]{64}$/),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
    nonce: z.string().min(1).max(128),
  })
  .strict();
const mcpWorkerAssertionHeaderSchema = z
  .object({
    alg: z.literal("ES256"),
    kid: z.string().min(1).max(128),
  })
  .strict();

export type McpWorkerAssertionPayload = z.infer<typeof mcpWorkerAssertionPayloadSchema>;

/** Signs a per-request Worker→Convex service assertion. */
export async function signMcpWorkerAssertion(
  payload: McpWorkerAssertionPayload,
  privateJwk: McpWorkerPrivateJwk,
) {
  const header = { alg: "ES256" as const, kid: privateJwk.kid };
  const headerB64 = toBase64Url(textEncoder.encode(JSON.stringify(header)));
  const payloadB64 = toBase64Url(textEncoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    textEncoder.encode(signingInput),
  );
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}

/** Verifies ES256 signature, claims shape, audience, and the bounded assertion lifetime. */
export async function verifyMcpWorkerAssertion(
  token: string,
  jwks: McpWorkerJwks,
  now: number = Date.now(),
) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) {
    return null;
  }
  try {
    const headerResult = mcpWorkerAssertionHeaderSchema.safeParse(
      JSON.parse(textDecoder.decode(fromBase64Url(headerB64))),
    );
    const payloadResult = mcpWorkerAssertionPayloadSchema.safeParse(
      JSON.parse(textDecoder.decode(fromBase64Url(payloadB64))),
    );
    if (!headerResult.success || !payloadResult.success) {
      return null;
    }
    const keyJwk = jwks.keys.find(({ kid }) => kid === headerResult.data.kid);
    if (!keyJwk) {
      return null;
    }
    const { iat, exp } = payloadResult.data;
    if (
      exp <= now ||
      iat > now + MCP_WORKER_ASSERTION_CLOCK_SKEW_MS ||
      exp <= iat ||
      exp - iat > MCP_WORKER_ASSERTION_TTL_MS
    ) {
      return null;
    }
    const key = await crypto.subtle.importKey(
      "jwk",
      keyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromBase64Url(signatureB64),
      textEncoder.encode(`${headerB64}.${payloadB64}`),
    );
    return valid ? payloadResult.data : null;
  } catch {
    return null;
  }
}

/**
 * Application approval token (#318): Convex signs this after consent; the SPA
 * POSTs it to the Worker; the Worker redeems it via the service bridge. Claims
 * bind User, client, redirect, resource, scopes, Circles, and handoff. Single-
 * use consumption is enforced by hashing the compact token in Convex.
 */
const mcpApprovalPayloadSchema = z.object({
  v: z.literal(1),
  jti: z.string().min(1),
  handoffId: z.string().min(1),
  grantId: z.string().min(1),
  userId: z.string().min(1),
  principalId: z.string().min(1),
  clientId: z.string().min(1),
  redirectUri: z.string().min(1),
  resource: z.string().min(1),
  scopes: z.array(z.string()),
  allowedCircleIds: z.array(z.string()),
  iat: z.number(),
  exp: z.number(),
});

export type McpApprovalPayload = z.infer<typeof mcpApprovalPayloadSchema>;

/** Signs the Convex→Worker application approval token after User consent. */
export async function signMcpApproval(payload: McpApprovalPayload, secret: string) {
  return signCompactToken(payload, secret);
}

/** Verifies signature, shape, and expiry. Caller must still enforce single-use via token hash. */
export async function verifyMcpApproval(
  token: string,
  secrets: string | readonly string[],
  now: number = Date.now(),
  options: { ignoreExpiry?: boolean } = {},
) {
  const parsed = await verifyCompactToken(token, secrets);
  const result = mcpApprovalPayloadSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  if (!options.ignoreExpiry && result.data.exp <= now) {
    return null;
  }
  return result.data;
}

const mcpRevocationPayloadSchema = z
  .object({
    v: z.literal(1),
    jti: z.string().min(1),
    grantId: z.string().min(1),
    principalId: z.string().min(1),
    workerGrantId: z.string().min(1),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
  })
  .strict();

export type McpRevocationPayload = z.infer<typeof mcpRevocationPayloadSchema>;

/** Signs a short-lived capability for the Worker to clean up one revoked grant. */
export async function signMcpRevocation(payload: McpRevocationPayload, secret: string) {
  return signCompactToken(payload, secret);
}

/** Verifies a Worker cleanup capability, including its bounded lifetime. */
export async function verifyMcpRevocation(
  token: string,
  secrets: string | readonly string[],
  now: number = Date.now(),
) {
  const parsed = await verifyCompactToken(token, secrets);
  const result = mcpRevocationPayloadSchema.safeParse(parsed);
  if (!result.success || result.data.exp <= now || result.data.exp <= result.data.iat) {
    return null;
  }
  if (result.data.exp - result.data.iat > MCP_REVOCATION_TTL_MS) {
    return null;
  }
  return result.data;
}
