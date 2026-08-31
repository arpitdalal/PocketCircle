/**
 * Browser-session half of the MCP consent flow (#318). The Worker signs a
 * short-lived handoff and redirects the User's browser here with it; Convex
 * verifies that signature (never trusts anything the browser could forge) and,
 * on approval, mints a single-use approval token the browser hands back to the
 * Worker. Convex never sees Worker OAuth state — only the handoff it signed.
 */

import {
  MCP_APPROVAL_TTL_MS,
  MCP_REFRESH_DURATION_LABEL,
  MUTATION_ERRORS,
  mutationErrorData,
  normalizeMcpScopes,
  verifyMcpHandoff,
} from "@pocketcircle/domain";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import { requireCurrentUser } from "./auth.js";
import { mintMcpApprovalToken } from "./mcpApprovalToken.js";
import { createPendingMcpGrant } from "./mcpGrant.js";
import { currentMcpWorkerSecret, mcpWorkerVerificationSecrets } from "./mcpWorkerSecrets.js";
import { generateOpaqueToken } from "./opaqueToken.js";

/** Verifies the handoff against the shared Worker secret. Fails closed (null) if unset, malformed, or expired. */
async function verifyHandoff(handoff: string) {
  const secrets = mcpWorkerVerificationSecrets();
  if (secrets.length === 0) {
    return null;
  }
  return await verifyMcpHandoff(handoff, secrets, Date.now());
}

/**
 * Safe, display-only fields decoded from the Worker's signed handoff for the
 * consent page. Returns null on any signature/shape/expiry failure — never a
 * partial or best-effort decode a client could use to probe the format.
 */
export const parseMcpHandoff = query({
  args: { handoff: v.string() },
  handler: async (_ctx, args) => {
    const payload = await verifyHandoff(args.handoff);
    if (!payload) {
      return null;
    }
    return {
      // handoffId is needed for deny → Worker lookup of the stored AuthRequest.
      // It cannot reconstruct OAuth params; those stay in Worker KV only.
      handoffId: payload.handoffId,
      clientId: payload.clientId,
      clientName: payload.clientName,
      clientUri: payload.clientUri,
      logoUri: payload.logoUri,
      redirectUri: payload.redirectUri,
      resource: payload.resource,
      scopes: payload.scopes,
      refreshDurationLabel: MCP_REFRESH_DURATION_LABEL,
    };
  },
});

/**
 * Records User consent: creates the pending PocketCircle grant and a
 * single-use approval token the SPA hands back to the Worker. The Worker
 * redeems that token (service-authenticated, see `mcpApproval.ts`) to link and
 * activate the grant during its own OAuth token exchange — Convex never issues
 * OAuth tokens itself.
 */
export const approveMcpAuthorization = mutation({
  args: {
    handoff: v.string(),
    selectedCircleIds: v.array(v.string()),
    grantedScopes: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    if (user.onboardingCompletedAt === null) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.mcpOnboardingRequired));
    }

    const handoffPayload = await verifyHandoff(args.handoff);
    if (!handoffPayload) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.mcpHandoffInvalid));
    }

    // Granted scopes must be a subset of what the Worker's handoff actually
    // requested — the User can narrow, never broaden, what the client asked for.
    const grantedScopes = normalizeMcpScopes(args.grantedScopes);
    if (!grantedScopes?.every((scope) => handoffPayload.scopes.includes(scope))) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.mcpScopesInvalid));
    }

    const pending = await createPendingMcpGrant(ctx, {
      userId: user._id,
      clientId: handoffPayload.clientId,
      clientKind: handoffPayload.clientKind,
      redirectUri: handoffPayload.redirectUri,
      clientDisplaySnapshot: {
        clientName: handoffPayload.clientName,
        clientUri: handoffPayload.clientUri,
        logoUri: handoffPayload.logoUri,
      },
      scopes: grantedScopes,
      allowedCircleIds: args.selectedCircleIds,
    });
    if (!pending.ok) {
      const code =
        pending.error === "invalid_circles"
          ? MUTATION_ERRORS.mcpCirclesInvalid
          : pending.error === "invalid_scopes"
            ? MUTATION_ERRORS.mcpScopesInvalid
            : MUTATION_ERRORS.mcpGrantFailed;
      throw new ConvexError(mutationErrorData(code));
    }
    const grant = pending.value;

    const secret = currentMcpWorkerSecret();
    if (!secret) {
      throw new ConvexError(mutationErrorData(MUTATION_ERRORS.mcpGrantFailed));
    }

    const now = Date.now();
    const expiresAt = now + MCP_APPROVAL_TTL_MS;
    const { token, tokenHash } = await mintMcpApprovalToken(
      {
        jti: generateOpaqueToken(),
        handoffId: handoffPayload.handoffId,
        grantId: grant._id,
        userId: user._id,
        principalId: grant.principalId,
        clientId: grant.clientId,
        redirectUri: grant.redirectUri,
        resource: handoffPayload.resource,
        scopes: grant.scopes,
        allowedCircleIds: grant.allowedCircleIds,
        iat: now,
        exp: expiresAt,
      },
      secret,
    );
    await ctx.db.insert("mcpApprovalTokens", {
      tokenHash,
      handoffId: handoffPayload.handoffId,
      grantId: grant._id,
      userId: user._id,
      principalId: grant.principalId,
      clientId: grant.clientId,
      redirectUri: grant.redirectUri,
      resource: handoffPayload.resource,
      scopes: grant.scopes,
      allowedCircleIds: grant.allowedCircleIds,
      expiresAt,
      createdAt: now,
    });

    return { approvalToken: token };
  },
});
