/**
 * MCP OAuth handoff + Worker-assertion primitives shared by the Convex consent
 * bridge and the MCP Worker (#318). Both payload kinds are compact
 * `base64url(json).base64url(hmac)` tokens signed with a secret only Convex and
 * the Worker hold (`MCP_WORKER_HMAC_SECRET`) — the browser and MCP client only
 * ever see the opaque signed string, never the secret or an unsigned payload.
 *
 * - Handoff: the Worker signs this when redirecting the browser to the
 *   PocketCircle consent page; Convex only verifies it (`parseMcpHandoff`,
 *   `approveMcpAuthorization`).
 * - Worker assertion: the Worker signs this per-request to authenticate its
 *   server-to-server calls into the Convex MCP bridge HTTP routes; Convex
 *   verifies method/path/body-digest/expiry/nonce before trusting the call.
 */

import { z } from "zod";

export const MCP_RESOURCE_URI = "https://mcp.pocketcircle.app/mcp";
export const MCP_ISSUER = "https://mcp.pocketcircle.app";
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 900;
export const MCP_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MCP_REFRESH_DURATION_LABEL = "30 days";
export const MCP_HANDOFF_TTL_MS = 10 * 60 * 1000;
export const MCP_APPROVAL_TTL_MS = 5 * 60 * 1000;

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
async function verifyCompactToken(token: string, secret: string): Promise<unknown> {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [payloadB64, macB64] = parts;
  if (!payloadB64 || !macB64) {
    return null;
  }
  return verifyDecodedCompactToken(payloadB64, macB64, secret);
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
  secret: string,
  now: number = Date.now(),
): Promise<McpHandoffPayload | null> {
  const parsed = await verifyCompactToken(token, secret);
  const result = mcpHandoffPayloadSchema.safeParse(parsed);
  if (!result.success || result.data.exp <= now) {
    return null;
  }
  return result.data;
}

const mcpWorkerAssertionPayloadSchema = z.object({
  aud: z.literal("pocketcircle:mcp-worker"),
  method: z.string().min(1),
  path: z.string().min(1),
  bodySha256: z.string().min(1),
  iat: z.number(),
  exp: z.number(),
  nonce: z.string().min(1),
});

export type McpWorkerAssertionPayload = z.infer<typeof mcpWorkerAssertionPayloadSchema>;

/** Signs a per-request Worker→Convex service assertion. */
export async function signMcpWorkerAssertion(payload: McpWorkerAssertionPayload, secret: string) {
  return signCompactToken(payload, secret);
}

/** Verifies signature, shape, and expiry. Caller must additionally check method/path/bodySha256/nonce against the live request. */
export async function verifyMcpWorkerAssertion(
  token: string,
  secret: string,
  now: number = Date.now(),
): Promise<McpWorkerAssertionPayload | null> {
  const parsed = await verifyCompactToken(token, secret);
  const result = mcpWorkerAssertionPayloadSchema.safeParse(parsed);
  if (!result.success || result.data.exp <= now) {
    return null;
  }
  return result.data;
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
  secret: string,
  now: number = Date.now(),
  options: { ignoreExpiry?: boolean } = {},
): Promise<McpApprovalPayload | null> {
  const parsed = await verifyCompactToken(token, secret);
  const result = mcpApprovalPayloadSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }
  if (!options.ignoreExpiry && result.data.exp <= now) {
    return null;
  }
  return result.data;
}
