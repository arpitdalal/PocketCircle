import { DurableObject } from "cloudflare:workers";
import { MCP_HANDOFF_TTL_MS } from "@pocketcircle/domain";
import { z } from "zod";

// Mirrors `AuthRequest` from @cloudflare/workers-oauth-provider so we can
// validate the round-trip without an `as` cast.
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

/**
 * Per-handoff Durable Object. Requests to the same object are serialized, so
 * get-then-delete in `consumeAuthRequest` is atomic under concurrent complete
 * and deny.
 */
export class HandoffStore extends DurableObject {
  async storeAuthRequest(authRequest: StoredAuthRequest) {
    await this.ctx.storage.put("authRequest", authRequest);
    await this.ctx.storage.setAlarm(Date.now() + MCP_HANDOFF_TTL_MS);
  }

  async consumeAuthRequest() {
    const raw = await this.ctx.storage.get("authRequest");
    if (raw === undefined) {
      return null;
    }
    await this.ctx.storage.delete("authRequest");
    await this.ctx.storage.deleteAlarm();
    const parsed = authRequestSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  override async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

export async function storeHandoffAuthRequest(
  ns: DurableObjectNamespace<HandoffStore>,
  handoffId: string,
  authRequest: StoredAuthRequest,
) {
  await ns.getByName(handoffId).storeAuthRequest(authRequest);
}

export async function consumeHandoffAuthRequest(
  ns: DurableObjectNamespace<HandoffStore>,
  handoffId: string,
) {
  return ns.getByName(handoffId).consumeAuthRequest();
}
