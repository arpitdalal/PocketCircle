import { MCP_HANDOFF_TTL_MS } from "@pocketcircle/domain";
import { z } from "zod";

// Mirrors `AuthRequest` from @cloudflare/workers-oauth-provider so we can
// validate the KV round-trip without an `as` cast.
const authRequestSchema = z.object({
  responseType: z.string(),
  clientId: z.string(),
  redirectUri: z.string(),
  scope: z.array(z.string()),
  state: z.string(),
  codeChallenge: z.string().optional(),
  codeChallengeMethod: z.string().optional(),
  resource: z.union([z.string(), z.array(z.string())]).optional(),
  issuer: z.string().optional(),
});

export type StoredAuthRequest = z.infer<typeof authRequestSchema>;

const HANDOFF_TTL_SECONDS = Math.ceil(MCP_HANDOFF_TTL_MS / 1000);

function handoffKey(handoffId: string) {
  return `handoff:${handoffId}`;
}

export async function storeHandoffAuthRequest(
  kv: KVNamespace,
  handoffId: string,
  authRequest: StoredAuthRequest,
) {
  await kv.put(handoffKey(handoffId), JSON.stringify(authRequest), {
    expirationTtl: HANDOFF_TTL_SECONDS,
  });
}

export async function loadHandoffAuthRequest(kv: KVNamespace, handoffId: string) {
  const raw = await kv.get(handoffKey(handoffId));
  if (raw === null) return null;
  const parsed = authRequestSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export async function deleteHandoffAuthRequest(kv: KVNamespace, handoffId: string) {
  await kv.delete(handoffKey(handoffId));
}
