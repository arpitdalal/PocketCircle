/**
 * User-facing MCP connection review and revocation (#320).
 *
 * Convex revokes its live grant in this mutation before the Worker is asked to
 * remove its OAuth grant. The Worker cleanup capability contains only opaque
 * grant identifiers, is short-lived, and is never part of the Connections view.
 */

import { MCP_REVOCATION_TTL_MS, signMcpRevocation } from "@pocketcircle/domain";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import { mutation, query } from "./_generated/server.js";
import { requireCurrentUser } from "./auth.js";
import { revokeMcpGrant } from "./mcpGrant.js";
import { currentMcpWorkerSecret } from "./mcpWorkerSecrets.js";
import { generateOpaqueToken } from "./opaqueToken.js";
import {
  listActiveMembershipsWithCirclesForUser,
  listAuthorizedCirclesFromMemberships,
} from "./operations.js";

function clientNameOf(clientName: string | undefined, clientId: string) {
  return clientName?.trim() || clientId;
}

/** Safe connection view: no User, principal, Worker grant, or credential fields. */
function toMcpConnectionView(
  grant: Doc<"mcpGrants">,
  memberships: Awaited<ReturnType<typeof listActiveMembershipsWithCirclesForUser>>,
) {
  const selectedCircles = listAuthorizedCirclesFromMemberships(grant, memberships);
  return {
    id: grant._id,
    clientId: grant.clientId,
    clientName: clientNameOf(grant.clientDisplaySnapshot.clientName, grant.clientId),
    clientUri: grant.clientDisplaySnapshot.clientUri ?? null,
    logoUri: grant.clientDisplaySnapshot.logoUri ?? null,
    redirectUri: grant.redirectUri,
    scopes: grant.scopes,
    selectedCircles,
    createdAt: grant.createdAt,
    status: grant.status,
    lastUsedAt: grant.lastUsedAt ?? null,
    workerCleanupStatus: grant.workerCleanupStatus,
  };
}

export const listMcpConnections = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const memberships = await listActiveMembershipsWithCirclesForUser(ctx, user);
    const grants = await ctx.db
      .query("mcpGrants")
      .withIndex("by_user_and_createdAt", (q) => q.eq("userId", user._id))
      .order("desc")
      .paginate(args.paginationOpts);

    const connections = grants.page.map((grant) => toMcpConnectionView(grant, memberships));
    return { ...grants, page: connections };
  },
});

export const revokeMcpConnection = mutation({
  args: { connectionId: v.string() },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const grantId = ctx.db.normalizeId("mcpGrants", args.connectionId);
    const grant = grantId ? await ctx.db.get(grantId) : null;

    // Do not reveal whether a forged id names another User's connection.
    if (!grant || grant.userId !== user._id) {
      return { ok: false as const, error: "connection_not_found" as const };
    }

    const revoked = await revokeMcpGrant(ctx, { grantId: grant._id });
    if (!revoked.ok) {
      return revoked;
    }

    const workerGrantId = revoked.value.workerGrantId;
    const secret = currentMcpWorkerSecret();
    if (!workerGrantId || revoked.value.workerCleanupStatus === "completed" || !secret) {
      return {
        ok: true as const,
        value: { cleanupToken: null, cleanupStatus: revoked.value.workerCleanupStatus },
      };
    }

    const now = Date.now();
    // Manual retry after exhaustion: re-arm pending so Worker confirmation can complete.
    let cleanupStatus = revoked.value.workerCleanupStatus;
    if (cleanupStatus === "exhausted") {
      await ctx.db.patch(revoked.value._id, {
        workerCleanupStatus: "pending_revoke",
        workerCleanupAttempts: 0,
        workerCleanupNextAttemptAt: now,
        workerCleanupLastError: undefined,
        updatedAt: now,
      });
      cleanupStatus = "pending_revoke";
    }

    const cleanupToken = await signMcpRevocation(
      {
        v: 1,
        jti: generateOpaqueToken(),
        grantId: String(revoked.value._id),
        principalId: revoked.value.principalId,
        workerGrantId,
        iat: now,
        exp: now + MCP_REVOCATION_TTL_MS,
      },
      secret,
    );
    return {
      ok: true as const,
      value: { cleanupToken, cleanupStatus },
    };
  },
});
