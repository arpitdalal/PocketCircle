/**
 * Worker-side half of the MCP consent + grant bridge (#318). Every function
 * here is `internal*` — reachable only from this deployment's own HTTP actions
 * (`http.ts`), which authenticate the Worker's signed service assertion before
 * calling in. No plaintext token or bearer material is ever logged.
 */

import {
  MCP_PENDING_GRANT_TTL_MS,
  mcpScopesInclude,
  normalizeMcpScopes,
  verifyMcpApproval,
} from "@pocketcircle/domain";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server.js";
import { hashMcpApprovalToken } from "./mcpApprovalToken.js";
import { activateMcpGrant, revokeMcpGrant } from "./mcpGrant.js";

export type RedeemApprovalTokenError = "not_found" | "expired" | "consumed";

/**
 * Atomically consumes a single-use approval token. Verifies the HMAC first so
 * a forged compact token never reaches the lookup. Convex's OCC makes consume
 * race-safe under concurrent redemption.
 */
export const redeemApprovalToken = internalMutation({
  args: { token: v.string(), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const secret = process.env.MCP_WORKER_HMAC_SECRET;
    if (!secret) {
      return { ok: false as const, error: "not_found" as const };
    }
    const verified = await verifyMcpApproval(args.token, secret, now, { ignoreExpiry: true });
    if (!verified) {
      return { ok: false as const, error: "not_found" as const };
    }

    const tokenHash = await hashMcpApprovalToken(args.token);
    const row = await ctx.db
      .query("mcpApprovalTokens")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (!row) {
      return { ok: false as const, error: "not_found" as const };
    }
    if (row.consumedAt !== undefined) {
      return { ok: false as const, error: "consumed" as const };
    }
    if (verified.exp <= now || row.expiresAt <= now) {
      return { ok: false as const, error: "expired" as const };
    }
    // Claims must match the stored row — signature alone is not enough if the
    // DB row was replaced or the hash collided somehow.
    if (
      row.grantId !== verified.grantId ||
      row.handoffId !== verified.handoffId ||
      row.principalId !== verified.principalId ||
      row.clientId !== verified.clientId ||
      row.redirectUri !== verified.redirectUri ||
      row.resource !== verified.resource
    ) {
      return { ok: false as const, error: "not_found" as const };
    }

    await ctx.db.patch(row._id, { consumedAt: now });

    return {
      ok: true as const,
      value: {
        grantId: row.grantId,
        principalId: row.principalId,
        clientId: row.clientId,
        redirectUri: row.redirectUri,
        resource: row.resource,
        scopes: row.scopes,
        allowedCircleIds: row.allowedCircleIds,
        handoffId: row.handoffId,
      },
    };
  },
});

/** Links the Worker's OAuth grant to the pending PocketCircle grant, activating it. */
export const activateGrantFromWorker = internalMutation({
  args: {
    grantId: v.string(),
    workerGrantId: v.string(),
    principalId: v.string(),
  },
  handler: async (ctx, args) => await activateMcpGrant(ctx, args),
});

export type ValidateActiveGrantError =
  | "grant_not_found"
  | "grant_inactive"
  | "principal_mismatch"
  | "invalid_scopes"
  | "scope_broadened";

/**
 * Read-only check the Worker runs on every refresh / tool call: the grant must
 * still be active, belong to the same principal, and the requested scopes must
 * not exceed the live grant's scopes — refresh can never broaden access beyond
 * what was originally approved, even if the stored OAuth grant record allows it.
 */
export const validateActiveGrant = internalQuery({
  args: {
    grantId: v.string(),
    principalId: v.string(),
    requestedScopes: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("mcpGrants", args.grantId);
    const grant = id ? await ctx.db.get(id) : null;
    if (!grant) {
      return { ok: false as const, error: "grant_not_found" as const };
    }
    if (grant.status !== "active") {
      return { ok: false as const, error: "grant_inactive" as const };
    }
    if (grant.principalId !== args.principalId) {
      return { ok: false as const, error: "principal_mismatch" as const };
    }
    const requestedScopes = normalizeMcpScopes(args.requestedScopes);
    if (!requestedScopes) {
      return { ok: false as const, error: "invalid_scopes" as const };
    }
    const withinGrant = requestedScopes.every((scope) => mcpScopesInclude(grant.scopes, scope));
    if (!withinGrant) {
      return { ok: false as const, error: "scope_broadened" as const };
    }

    return {
      ok: true as const,
      value: {
        grantId: grant._id,
        userId: grant.userId,
        principalId: grant.principalId,
        scopes: requestedScopes,
        allowedCircleIds: grant.allowedCircleIds,
      },
    };
  },
});

/** Inserts a Worker-assertion nonce; returns false when it was already used (replay). */
export const consumeWorkerNonce = internalMutation({
  args: { nonce: v.string(), expiresAt: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("mcpWorkerNonces")
      .withIndex("by_nonce", (q) => q.eq("nonce", args.nonce))
      .unique();
    if (existing) {
      return false;
    }
    await ctx.db.insert("mcpWorkerNonces", { nonce: args.nonce, expiresAt: args.expiresAt });
    return true;
  },
});

const EXPIRED_CLEANUP_BATCH = 100;
const EXPIRED_CLEANUP_CAP = 500;

function resolvedCleanupLimit(limit: number | undefined) {
  if (limit === undefined) {
    return EXPIRED_CLEANUP_CAP;
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    return null;
  }
  return limit;
}

function shouldContinueCleanup(deleted: number, maxTotal: number) {
  return maxTotal > 0 && deleted === maxTotal;
}

async function deleteExpiredRows(
  ctx: MutationCtx,
  table: "mcpWorkerNonces" | "mcpApprovalTokens",
  now: number,
  maxTotal: number,
) {
  let totalDeleted = 0;
  while (totalDeleted < maxTotal) {
    const takeCount = Math.min(EXPIRED_CLEANUP_BATCH, maxTotal - totalDeleted);
    const expired = await ctx.db
      .query(table)
      .withIndex("by_expires", (q) => q.lte("expiresAt", now))
      .take(takeCount);
    if (expired.length === 0) {
      break;
    }
    for (const row of expired) {
      await ctx.db.delete(row._id);
    }
    totalDeleted += expired.length;
    if (expired.length < takeCount) {
      break;
    }
  }
  return totalDeleted;
}

async function revokeExpiredPendingGrants(ctx: MutationCtx, now: number, maxTotal: number) {
  const cutoff = now - MCP_PENDING_GRANT_TTL_MS;
  let totalRevoked = 0;
  while (totalRevoked < maxTotal) {
    const takeCount = Math.min(EXPIRED_CLEANUP_BATCH, maxTotal - totalRevoked);
    const expired = await ctx.db
      .query("mcpGrants")
      .withIndex("by_status_and_created", (q) => q.eq("status", "pending").lte("createdAt", cutoff))
      .take(takeCount);
    if (expired.length === 0) {
      break;
    }
    for (const row of expired) {
      await revokeMcpGrant(ctx, { grantId: row._id, now });
    }
    totalRevoked += expired.length;
    if (expired.length < takeCount) {
      break;
    }
  }
  return totalRevoked;
}

/**
 * Deletes expired Worker assertion nonces using the `by_expires` index.
 * Hits the per-run cap → schedules another batch until the expired set is empty.
 */
export const cleanupExpiredWorkerNonces = internalMutation({
  args: { now: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const maxTotal = resolvedCleanupLimit(args.limit);
    if (maxTotal === null) {
      return 0;
    }
    const deleted = await deleteExpiredRows(ctx, "mcpWorkerNonces", now, maxTotal);
    if (shouldContinueCleanup(deleted, maxTotal)) {
      await ctx.scheduler.runAfter(0, internal.mcpApproval.cleanupExpiredWorkerNonces, {
        now,
        limit: maxTotal,
      });
    }
    return deleted;
  },
});

/**
 * Deletes expired MCP approval tokens using the `by_expires` index.
 * Hits the per-run cap → schedules another batch until the expired set is empty.
 */
export const cleanupExpiredApprovalTokens = internalMutation({
  args: { now: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const maxTotal = resolvedCleanupLimit(args.limit);
    if (maxTotal === null) {
      return 0;
    }
    const deleted = await deleteExpiredRows(ctx, "mcpApprovalTokens", now, maxTotal);
    if (shouldContinueCleanup(deleted, maxTotal)) {
      await ctx.scheduler.runAfter(0, internal.mcpApproval.cleanupExpiredApprovalTokens, {
        now,
        limit: maxTotal,
      });
    }
    return deleted;
  },
});

/**
 * Revokes pending grants whose approval window elapsed without Worker activation.
 * Hits the per-run cap → schedules another batch until the expired set is empty.
 */
export const cleanupExpiredPendingMcpGrants = internalMutation({
  args: { now: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const maxTotal = resolvedCleanupLimit(args.limit);
    if (maxTotal === null) {
      return 0;
    }
    const revoked = await revokeExpiredPendingGrants(ctx, now, maxTotal);
    if (shouldContinueCleanup(revoked, maxTotal)) {
      await ctx.scheduler.runAfter(0, internal.mcpApproval.cleanupExpiredPendingMcpGrants, {
        now,
        limit: maxTotal,
      });
    }
    return revoked;
  },
});
