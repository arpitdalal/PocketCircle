import { DurableObject } from "cloudflare:workers";
import { MCP_HANDOFF_TTL_MS, sha256Hex } from "@pocketcircle/domain";
import { z } from "zod";
import { redeemApproval, redeemApprovalValueSchema } from "./convex-bridge.js";
import type { Env } from "./env.js";
import { pocketCircleOAuthApi } from "./oauth-options.js";
import { mcpResourceUri } from "./reachable.js";

// Mirrors `AuthRequest` from @cloudflare/workers-oauth-provider so evicted
// Durable Objects never trust unvalidated storage.
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

const phaseSchema = z.enum(["pending", "claimed", "redeemed", "completed", "denied"]);
const redirectResultSchema = z.object({ redirectTo: z.string() });

export type StoredAuthRequest = z.infer<typeof authRequestSchema>;

// Covers lost upstream responses plus the provider's ten-minute code exchange
// window. Completed redirects need only a bounded browser replay window.
const COMPLETION_RECOVERY_TTL_MS = 20 * 60 * 1_000;
const RESULT_REPLAY_TTL_MS = 10 * 60 * 1_000;

function accessDeniedRedirectTo(authRequest: StoredAuthRequest, description: string) {
  const redirect = new URL(authRequest.redirectUri);
  redirect.searchParams.set("error", "access_denied");
  redirect.searchParams.set("error_description", description);
  if (authRequest.state) {
    redirect.searchParams.set("state", authRequest.state);
  }
  if (authRequest.issuer) {
    redirect.searchParams.set("iss", authRequest.issuer);
  }
  return redirect.toString();
}

/** One object owns the complete authorization state machine for one handoff. */
export class HandoffStore extends DurableObject<Env> {
  private activeCompletion?: {
    approvalTokenHash: string;
    promise: ReturnType<HandoffStore["runCompletion"]>;
  };

  async storeAuthRequest(handoffId: string, authRequest: StoredAuthRequest, handoffToken: string) {
    const expiresAt = Date.now() + MCP_HANDOFF_TTL_MS;
    await this.ctx.storage.put({
      phase: "pending",
      handoffId,
      authRequest,
      handoffToken,
      expiresAt,
    });
    await this.ctx.storage.setAlarm(expiresAt);
  }

  async loadOrResume(origin: string, now = Date.now()) {
    const [phaseValue, handoffToken, expiresAt, completionHash, approvalToken, result] =
      await Promise.all([
        this.ctx.storage.get("phase"),
        this.ctx.storage.get("handoffToken"),
        this.ctx.storage.get("expiresAt"),
        this.ctx.storage.get("completionHash"),
        this.ctx.storage.get("approvalToken"),
        this.ctx.storage.get("completionResult"),
      ]);
    const phase = phaseSchema.safeParse(phaseValue);
    const completed = redirectResultSchema.safeParse(result);
    if (phase.success && (phase.data === "completed" || phase.data === "denied")) {
      return completed.success
        ? { kind: "completed" as const, redirectTo: completed.data.redirectTo }
        : { kind: "expired" as const };
    }
    if ((!phase.success || phase.data === "pending") && typeof handoffToken === "string") {
      return typeof expiresAt === "number" && expiresAt > now
        ? { kind: "handoff" as const, handoff: handoffToken }
        : { kind: "expired" as const };
    }
    if (
      phase.success &&
      (phase.data === "claimed" || phase.data === "redeemed") &&
      typeof completionHash === "string"
    ) {
      const token = typeof approvalToken === "string" ? approvalToken : undefined;
      return this.startCompletion(completionHash, token, origin, now);
    }
    return { kind: "expired" as const };
  }

  async completeAuthorization(approvalToken: string, origin: string, now = Date.now()) {
    const approvalTokenHash = await sha256Hex(approvalToken);
    return this.startCompletion(approvalTokenHash, approvalToken, origin, now);
  }

  private async startCompletion(
    approvalTokenHash: string,
    approvalToken: string | undefined,
    origin: string,
    now: number,
  ) {
    if (this.activeCompletion) {
      if (this.activeCompletion.approvalTokenHash !== approvalTokenHash) {
        return { kind: "approval_mismatch" as const };
      }
      return this.activeCompletion.promise;
    }

    const active = {
      approvalTokenHash,
      promise: this.runCompletion(approvalTokenHash, approvalToken, origin, now),
    };
    this.activeCompletion = active;
    try {
      return await active.promise;
    } finally {
      if (this.activeCompletion === active) {
        this.activeCompletion = undefined;
      }
    }
  }

  private async runCompletion(
    approvalTokenHash: string,
    suppliedApprovalToken: string | undefined,
    origin: string,
    now: number,
  ) {
    const prepared = await this.ctx.storage.transaction(async (storage) => {
      const phaseValue = await storage.get("phase");
      const phase = phaseSchema.safeParse(phaseValue);
      const completed = redirectResultSchema.safeParse(await storage.get("completionResult"));
      if (phase.success && phase.data === "completed" && completed.success) {
        const storedHash = await storage.get("completionHash");
        return storedHash === approvalTokenHash
          ? { kind: "completed" as const, redirectTo: completed.data.redirectTo }
          : { kind: "approval_mismatch" as const };
      }
      if (phase.success && phase.data === "denied") {
        return { kind: "denied" as const };
      }

      const authRequest = authRequestSchema.safeParse(await storage.get("authRequest"));
      if (!authRequest.success) {
        return { kind: "expired" as const };
      }
      const storedHash = await storage.get("completionHash");
      if (typeof storedHash === "string" && storedHash !== approvalTokenHash) {
        return { kind: "approval_mismatch" as const };
      }

      const normalizedPhase = phase.success ? phase.data : "pending";
      if (normalizedPhase === "pending") {
        const expiresAt = await storage.get("expiresAt");
        if (typeof expiresAt !== "number" || expiresAt <= now || !suppliedApprovalToken) {
          return { kind: "expired" as const };
        }
        const claimId = crypto.randomUUID();
        const recoveryExpiresAt = now + COMPLETION_RECOVERY_TTL_MS;
        await storage.put({
          phase: "claimed",
          completionHash: approvalTokenHash,
          completionClaimId: claimId,
          approvalToken: suppliedApprovalToken,
          recoveryExpiresAt,
        });
        await storage.setAlarm(recoveryExpiresAt);
        return {
          kind: "claimed" as const,
          authRequest: authRequest.data,
          claimId,
          approvalToken: suppliedApprovalToken,
        };
      }

      const recoveryExpiresAt = await storage.get("recoveryExpiresAt");
      if (typeof recoveryExpiresAt !== "number" || recoveryExpiresAt <= now) {
        return { kind: "expired" as const };
      }
      const redeemed = redeemApprovalValueSchema.safeParse(await storage.get("redeemedGrant"));
      if (normalizedPhase === "redeemed" && redeemed.success) {
        return {
          kind: "redeemed" as const,
          authRequest: authRequest.data,
          grant: redeemed.data,
        };
      }
      const claimId = await storage.get("completionClaimId");
      const storedApprovalToken = await storage.get("approvalToken");
      if (
        normalizedPhase !== "claimed" ||
        typeof claimId !== "string" ||
        typeof storedApprovalToken !== "string"
      ) {
        return { kind: "unavailable" as const };
      }
      return {
        kind: "claimed" as const,
        authRequest: authRequest.data,
        claimId,
        approvalToken: storedApprovalToken,
      };
    });

    if (prepared.kind !== "claimed" && prepared.kind !== "redeemed") {
      return prepared;
    }

    let grant: z.infer<typeof redeemApprovalValueSchema>;
    if (prepared.kind === "claimed") {
      const handoffId = await this.ctx.storage.get("handoffId");
      if (typeof handoffId !== "string") {
        return { kind: "expired" as const };
      }
      const redeemed = await redeemApproval(this.env, {
        token: prepared.approvalToken,
        handoffId,
        claimId: prepared.claimId,
      });
      if (!redeemed.ok) {
        if (!redeemed.retryable) {
          await this.resetClaim();
        }
        return {
          kind: "failed" as const,
          error: redeemed.error,
          retryable: redeemed.retryable,
        };
      }
      grant = redeemed.value;
      await this.ctx.storage.put({ phase: "redeemed", redeemedGrant: grant });
      await this.ctx.storage.delete("approvalToken");
    } else {
      grant = prepared.grant;
    }

    const authRequest = prepared.authRequest;
    const handoffId = await this.ctx.storage.get("handoffId");
    const requestedResource = Array.isArray(authRequest.resource)
      ? authRequest.resource[0]
      : authRequest.resource;
    const expectedResource = requestedResource ?? mcpResourceUri(this.env, origin);
    if (
      typeof handoffId !== "string" ||
      grant.handoffId !== handoffId ||
      authRequest.clientId !== grant.clientId ||
      authRequest.redirectUri !== grant.redirectUri ||
      grant.resource !== expectedResource
    ) {
      return { kind: "failed" as const, error: "handoff_grant_mismatch", retryable: false };
    }

    try {
      const completed = await pocketCircleOAuthApi(this.env, origin).completeAuthorization({
        request: authRequest,
        userId: grant.principalId,
        metadata: { pocketCircleGrantId: grant.grantId },
        scope: grant.scopes,
        props: { mcpGrantId: grant.grantId },
        revokeExistingGrants: false,
      });
      const replayExpiresAt = Date.now() + RESULT_REPLAY_TTL_MS;
      await this.ctx.storage.put({
        phase: "completed",
        completionResult: { redirectTo: completed.redirectTo },
        replayExpiresAt,
      });
      await this.ctx.storage.delete(["authRequest", "handoffToken", "redeemedGrant"]);
      await this.ctx.storage.setAlarm(replayExpiresAt);
      return { kind: "completed" as const, redirectTo: completed.redirectTo };
    } catch {
      return {
        kind: "failed" as const,
        error: "authorization_completion_unavailable",
        retryable: true,
      };
    }
  }

  private async resetClaim() {
    const expiresAt = await this.ctx.storage.get("expiresAt");
    await this.ctx.storage.put("phase", "pending");
    await this.ctx.storage.delete([
      "completionHash",
      "completionClaimId",
      "approvalToken",
      "recoveryExpiresAt",
    ]);
    if (typeof expiresAt === "number" && expiresAt > Date.now()) {
      await this.ctx.storage.setAlarm(expiresAt);
    }
  }

  async denyAuthorization(now = Date.now()) {
    return this.ctx.storage.transaction(async (storage) => {
      const phase = phaseSchema.safeParse(await storage.get("phase"));
      const cached = redirectResultSchema.safeParse(await storage.get("completionResult"));
      if (phase.success && phase.data === "denied" && cached.success) {
        return { ok: true as const, redirectTo: cached.data.redirectTo };
      }
      if (phase.success && phase.data !== "pending") {
        return { ok: false as const, error: "handoff_already_approved" };
      }
      const authRequest = authRequestSchema.safeParse(await storage.get("authRequest"));
      const expiresAt = await storage.get("expiresAt");
      if (!authRequest.success || typeof expiresAt !== "number" || expiresAt <= now) {
        return { ok: false as const, error: "handoff_expired_or_replayed" };
      }
      const redirectTo = accessDeniedRedirectTo(
        authRequest.data,
        "User denied the authorization request",
      );
      const replayExpiresAt = now + RESULT_REPLAY_TTL_MS;
      await storage.put({
        phase: "denied",
        completionResult: { redirectTo },
        replayExpiresAt,
      });
      await storage.delete(["authRequest", "handoffToken"]);
      await storage.setAlarm(replayExpiresAt);
      return { ok: true as const, redirectTo };
    });
  }

  override async alarm() {
    if (this.activeCompletion) {
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return;
    }
    await this.ctx.storage.deleteAll();
  }
}

function handoffStore(ns: DurableObjectNamespace<HandoffStore>, handoffId: string) {
  return ns.getByName(handoffId);
}

export async function storeHandoffAuthRequest(
  ns: DurableObjectNamespace<HandoffStore>,
  handoffId: string,
  authRequest: StoredAuthRequest,
  handoffToken: string,
) {
  await handoffStore(ns, handoffId).storeAuthRequest(handoffId, authRequest, handoffToken);
}

export function loadOrResumeHandoff(
  ns: DurableObjectNamespace<HandoffStore>,
  handoffId: string,
  origin: string,
) {
  return handoffStore(ns, handoffId).loadOrResume(origin);
}

export function completeHandoffAuthorization(
  ns: DurableObjectNamespace<HandoffStore>,
  handoffId: string,
  approvalToken: string,
  origin: string,
) {
  return handoffStore(ns, handoffId).completeAuthorization(approvalToken, origin);
}

export function denyHandoffAuthorization(
  ns: DurableObjectNamespace<HandoffStore>,
  handoffId: string,
) {
  return handoffStore(ns, handoffId).denyAuthorization();
}
