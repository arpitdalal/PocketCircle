import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import type { Env } from "./env.js";

const PROVISIONING_PATH = "/admin/oauth/clients";
const MAX_BODY_BYTES = 8_192;
const MIN_SECRET_BYTES = 32;

function safeMetadataUrl(value: string) {
  return new URL(value).protocol === "https:";
}

function safeRedirectUri(value: string) {
  const protocol = new URL(value).protocol;
  return !["javascript:", "data:", "vbscript:", "file:", "mailto:", "blob:"].includes(protocol);
}

const clientInputSchema = z
  .object({
    clientName: z.string().trim().min(1).max(200),
    clientUri: z.url().max(2_048).refine(safeMetadataUrl).optional(),
    redirectUris: z.array(z.url().max(2_048).refine(safeRedirectUri)).min(1).max(20),
  })
  .strict()
  .transform((input) => ({
    ...input,
    redirectUris: [...new Set(input.redirectUris)].sort(),
  }));

function json(status: number, body: unknown, headers?: HeadersInit) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

async function equalSecret(received: string, expected: string) {
  const encoder = new TextEncoder();
  const [receivedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(received)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const receivedBytes = new Uint8Array(receivedHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = receivedBytes.length ^ expectedBytes.length;
  for (let index = 0; index < receivedBytes.length; index += 1) {
    difference |= (receivedBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }
  return difference === 0;
}

async function isAuthorized(request: Request, secret: string) {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer ([^\s]+)$/i);
  const token = bearer?.[1];
  if (!token) {
    return false;
  }
  return equalSecret(token, secret);
}

async function readBoundedJson(request: Request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return null;
  }
  if (!request.body) {
    return null;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    size += chunk.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
}

function sameStrings(left: string[] | undefined, right: string[]) {
  if (!left || left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function matchesClient(
  client: Awaited<ReturnType<OAuthHelpers["listClients"]>>["items"][number],
  input: z.infer<typeof clientInputSchema>,
) {
  return (
    client.clientName === input.clientName &&
    client.clientUri === input.clientUri &&
    client.tokenEndpointAuthMethod === "none" &&
    sameStrings(client.redirectUris, input.redirectUris) &&
    sameStrings(client.grantTypes, ["authorization_code", "refresh_token"]) &&
    sameStrings(client.responseTypes, ["code"])
  );
}

async function findExistingClient(oauth: OAuthHelpers, input: z.infer<typeof clientInputSchema>) {
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
    const page = await oauth.listClients({ limit: 1000, ...(cursor ? { cursor } : {}) });
    const existing = page.items.find((client) => matchesClient(client, input));
    if (existing || !page.cursor) {
      return existing ?? null;
    }
    cursor = page.cursor;
  }
  throw new Error("OAuth client registry exceeds the provisioning scan limit");
}

/**
 * Authenticated, intentionally temporary bootstrap surface for static OAuth
 * clients. Remove the secret after provisioning to make the route disappear.
 */
export async function handleClientProvisioning(request: Request, env: Env) {
  const url = new URL(request.url);
  if (url.pathname !== PROVISIONING_PATH) {
    return null;
  }
  if (
    !env.MCP_CLIENT_PROVISIONING_TOKEN ||
    new TextEncoder().encode(env.MCP_CLIENT_PROVISIONING_TOKEN).byteLength < MIN_SECRET_BYTES
  ) {
    return new Response("Not found", { status: 404 });
  }
  if (request.method !== "POST") {
    return json(405, { error: "method_not_allowed" }, { allow: "POST" });
  }
  if (!(await isAuthorized(request, env.MCP_CLIENT_PROVISIONING_TOKEN))) {
    return json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
  }
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return json(415, { error: "unsupported_media_type" });
  }

  const parsed = clientInputSchema.safeParse(await readBoundedJson(request));
  if (!parsed.success) {
    return json(400, { error: "invalid_client_metadata" });
  }

  const existing = await findExistingClient(env.OAUTH_PROVIDER, parsed.data);
  if (existing) {
    return json(200, { clientId: existing.clientId, created: false });
  }

  const created = await env.OAUTH_PROVIDER.createClient({
    clientName: parsed.data.clientName,
    clientUri: parsed.data.clientUri,
    redirectUris: parsed.data.redirectUris,
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  return json(201, { clientId: created.clientId, created: true });
}
