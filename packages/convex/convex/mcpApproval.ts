/**
 * Worker-side half of the MCP consent + grant bridge (#318). Every function
 * here is `internal*` — reachable only from this deployment's own HTTP actions
 * (`http.ts`), which authenticate the Worker's signed service assertion before
 * calling in. No plaintext token or bearer material is ever logged.
 */

import {
  MCP_PENDING_ACTIVATION_TTL_MS,
  MCP_PENDING_GRANT_TTL_MS,
  mcpCategoryAnalyticsSchema,
  mcpCategoryDetailSchema,
  mcpCircleViewSchema,
  mcpDashboardSchema,
  mcpListCategoryTransactionsResultSchema,
  mcpMonthlyComparisonSchema,
  mcpMonthlyLedgerSchema,
  mcpPaginatedCategoriesSchema,
  mcpPaginatedCategoryHistorySchema,
  mcpPaginatedCircleHistorySchema,
  mcpPaginatedMembersSchema,
  mcpPaginatedTransactionHistorySchema,
  mcpScopesInclude,
  mcpSearchTransactionsResultSchema,
  mcpTransactionDetailSchema,
  normalizeMcpImage,
  normalizeMcpScopes,
  verifyMcpApproval,
} from "@pocketcircle/domain";
import { v } from "convex/values";
import type { z } from "zod";
import { internal } from "./_generated/api.js";
import type { Doc } from "./_generated/dataModel.js";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server.js";
import { hashMcpApprovalToken } from "./mcpApprovalToken.js";
import {
  activateMcpGrant,
  authorizeMcpGrant,
  authorizeMcpGrantForCircle,
  recordMcpGrantUse,
  revokeMcpGrant,
} from "./mcpGrant.js";
import { mcpWorkerVerificationSecrets } from "./mcpWorkerSecrets.js";
import {
  getCategoryAnalyticsForUser,
  getCategoryForUser,
  getDashboardForUser,
  getMonthlyComparisonForUser,
  getMonthlyLedgerForUser,
  getTransactionForUser,
  listAuthorizedCirclesForGrant,
  listCategoriesForUser,
  listCategoryHistoryForUser,
  listCategoryTransactionsForUser,
  listCircleHistoryForUser,
  listTransactionHistoryForUser,
  paginateMembersForUser,
  resolveCircleRef,
  searchTransactionsForUser,
  toMcpCircleView,
  toMcpCurrentUserView,
} from "./operations.js";

export type RedeemApprovalTokenError = "not_found" | "expired" | "consumed";

const mcpPaginationOptsValidator = v.object({
  numItems: v.number(),
  cursor: v.union(v.string(), v.null()),
});

function validateMcpResult<T>(schema: z.ZodType<T>, value: unknown) {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true as const, value: parsed.data }
    : { ok: false as const, error: "invalid_result" as const };
}

/**
 * Atomically claims a single-use approval token. The same durable Worker claim
 * may retry after a lost response; another claim is rejected as consumed.
 * Convex's OCC makes competing claims race-safe.
 */
function redeemedApprovalValue(row: Doc<"mcpApprovalTokens">) {
  return {
    grantId: row.grantId,
    principalId: row.principalId,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    resource: row.resource,
    scopes: row.scopes,
    allowedCircleIds: row.allowedCircleIds,
    handoffId: row.handoffId,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export const redeemApprovalToken = internalMutation({
  args: {
    token: v.string(),
    handoffId: v.string(),
    claimId: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const secrets = mcpWorkerVerificationSecrets();
    if (secrets.length === 0 || args.claimId.trim() === "") {
      return { ok: false as const, error: "not_found" as const };
    }
    const verified = await verifyMcpApproval(args.token, secrets, now, { ignoreExpiry: true });
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
    if (row.handoffId !== args.handoffId || verified.handoffId !== args.handoffId) {
      return { ok: false as const, error: "not_found" as const };
    }
    if (row.consumedAt !== undefined && row.claimId === args.claimId) {
      return { ok: true as const, value: redeemedApprovalValue(row) };
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
      row.userId !== verified.userId ||
      row.principalId !== verified.principalId ||
      row.clientId !== verified.clientId ||
      row.redirectUri !== verified.redirectUri ||
      row.resource !== verified.resource ||
      row.expiresAt !== verified.exp ||
      !sameStrings(row.scopes, verified.scopes) ||
      !sameStrings(row.allowedCircleIds, verified.allowedCircleIds)
    ) {
      return { ok: false as const, error: "not_found" as const };
    }

    const grant = await ctx.db.get(row.grantId);
    if (grant?.status !== "pending") {
      return { ok: false as const, error: "not_found" as const };
    }
    await ctx.db.patch(grant._id, {
      activationExpiresAt: now + MCP_PENDING_ACTIVATION_TTL_MS,
      updatedAt: now,
    });
    await ctx.db.patch(row._id, { consumedAt: now, claimId: args.claimId });

    return {
      ok: true as const,
      value: redeemedApprovalValue(row),
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

/** Marks Worker cleanup complete only for the exact revoked grant linkage. */
export const completeRevocationFromWorker = internalMutation({
  args: {
    grantId: v.string(),
    workerGrantId: v.string(),
    principalId: v.string(),
  },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("mcpGrants", args.grantId);
    const grant = id ? await ctx.db.get(id) : null;
    if (!grant) {
      return { ok: false as const, error: "grant_not_found" as const };
    }
    if (grant.principalId !== args.principalId || grant.workerGrantId !== args.workerGrantId) {
      return { ok: false as const, error: "grant_mismatch" as const };
    }
    if (grant.status !== "revoked") {
      return { ok: false as const, error: "grant_not_revoked" as const };
    }
    if (grant.workerCleanupStatus === "completed") {
      return { ok: true as const };
    }
    if (grant.workerCleanupStatus !== "pending_revoke") {
      return { ok: false as const, error: "cleanup_not_pending" as const };
    }
    await ctx.db.patch(grant._id, {
      workerCleanupStatus: "completed",
      updatedAt: Date.now(),
    });
    return { ok: true as const };
  },
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

export const recordMcpGrantUseFromWorker = internalMutation({
  args: { grantId: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("mcpGrants", args.grantId);
    if (!id) {
      return { ok: false as const, error: "grant_not_found" as const };
    }
    await recordMcpGrantUse(ctx, { grantId: id });
    return { ok: true as const };
  },
});

export const executeMcpReadOperation = internalQuery({
  args: {
    grantId: v.string(),
    effectiveScopes: v.array(v.string()),
    operation: v.union(
      v.object({ kind: v.literal("get_current_user") }),
      v.object({ kind: v.literal("list_authorized_circles") }),
      v.object({ kind: v.literal("get_circle"), circleRef: v.string() }),
      v.object({
        kind: v.literal("list_members"),
        circleRef: v.string(),
        includeHistorical: v.optional(v.boolean()),
        paginationOpts: v.optional(mcpPaginationOptsValidator),
      }),
      v.object({
        kind: v.literal("list_circle_history"),
        circleRef: v.string(),
        paginationOpts: v.optional(mcpPaginationOptsValidator),
      }),
      v.object({
        kind: v.literal("search_transactions"),
        circleRef: v.string(),
        filters: v.optional(
          v.object({
            query: v.optional(v.string()),
            type: v.optional(v.union(v.literal("all"), v.literal("expense"), v.literal("income"))),
            status: v.optional(
              v.union(v.literal("active"), v.literal("archived"), v.literal("all")),
            ),
            categoryRefs: v.optional(v.array(v.string())),
            recordedByMemberIds: v.optional(v.array(v.string())),
            paidByMemberIds: v.optional(v.array(v.string())),
            dateFrom: v.optional(v.string()),
            dateTo: v.optional(v.string()),
            amountMin: v.optional(v.number()),
            amountMax: v.optional(v.number()),
            month: v.optional(v.string()),
          }),
        ),
        page: v.optional(v.number()),
        pageSize: v.optional(v.number()),
        paginationOpts: v.optional(mcpPaginationOptsValidator),
      }),
      v.object({
        kind: v.literal("get_transaction"),
        circleRef: v.string(),
        transactionRef: v.string(),
      }),
      v.object({
        kind: v.literal("list_transaction_history"),
        circleRef: v.string(),
        transactionRef: v.string(),
        paginationOpts: v.optional(mcpPaginationOptsValidator),
      }),
      v.object({
        kind: v.literal("get_monthly_ledger"),
        circleRef: v.string(),
        month: v.string(),
        paginationOpts: v.optional(mcpPaginationOptsValidator),
      }),
      v.object({
        kind: v.literal("get_dashboard"),
        circleRef: v.string(),
        month: v.string(),
      }),
      v.object({
        kind: v.literal("get_monthly_comparison"),
        circleRef: v.string(),
        endMonth: v.string(),
        rangeMonths: v.union(v.literal(1), v.literal(3), v.literal(6), v.literal(12)),
      }),
      v.object({
        kind: v.literal("get_category_analytics"),
        circleRef: v.string(),
        month: v.string(),
        type: v.union(v.literal("expense"), v.literal("income")),
        paginationOpts: v.optional(mcpPaginationOptsValidator),
      }),
      v.object({
        kind: v.literal("list_categories"),
        circleRef: v.string(),
        filters: v.optional(
          v.object({
            type: v.optional(v.union(v.literal("all"), v.literal("expense"), v.literal("income"))),
            status: v.optional(
              v.union(v.literal("active"), v.literal("archived"), v.literal("all")),
            ),
            query: v.optional(v.string()),
          }),
        ),
        paginationOpts: v.optional(mcpPaginationOptsValidator),
      }),
      v.object({
        kind: v.literal("get_category"),
        circleRef: v.string(),
        categoryRef: v.string(),
      }),
      v.object({
        kind: v.literal("list_category_transactions"),
        circleRef: v.string(),
        categoryRef: v.string(),
      }),
      v.object({
        kind: v.literal("list_category_history"),
        circleRef: v.string(),
        categoryRef: v.string(),
        paginationOpts: v.optional(mcpPaginationOptsValidator),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const authz = await authorizeMcpGrant(ctx, {
      grantId: args.grantId,
      effectiveScopes: args.effectiveScopes,
      requiredScope: "pocketcircle:read",
    });
    if (!authz.ok) {
      return { ok: false as const, error: authz.denial.kind, denial: authz.denial };
    }
    const { grant, user } = authz.value;

    if (args.operation.kind === "get_current_user") {
      return {
        ok: true as const,
        value: toMcpCurrentUserView(user),
      };
    }

    if (args.operation.kind === "list_authorized_circles") {
      const circles = await listAuthorizedCirclesForGrant(ctx, grant, user);
      return {
        ok: true as const,
        value: { circles },
      };
    }

    const circleId = resolveCircleRef(ctx, args.operation.circleRef);
    const circleAuthz = await authorizeMcpGrantForCircle(ctx, {
      grantId: grant._id,
      effectiveScopes: args.effectiveScopes,
      requiredScope: "pocketcircle:read",
      circleId: circleId ?? args.operation.circleRef,
      requiredPermission: "member",
    });
    if (!circleAuthz.ok) {
      return { ok: false as const, error: circleAuthz.denial.kind, denial: circleAuthz.denial };
    }

    if (args.operation.kind === "get_circle") {
      const value = toMcpCircleView(
        circleAuthz.value.access.circle,
        circleAuthz.value.access.isOwner,
      );
      return validateMcpResult(mcpCircleViewSchema, value);
    }

    if (args.operation.kind === "list_members") {
      const members = await paginateMembersForUser(
        ctx,
        circleAuthz.value.access.circle._id,
        user,
        args.operation.includeHistorical ?? false,
        args.operation.paginationOpts ?? { numItems: 50, cursor: null },
      );
      return validateMcpResult(mcpPaginatedMembersSchema, members);
    }

    if (args.operation.kind === "list_circle_history") {
      const history = await listCircleHistoryForUser(
        ctx,
        circleAuthz.value.access.circle._id,
        user,
        args.operation.paginationOpts ?? { numItems: 50, cursor: null },
      );
      const value = {
        ...history,
        page: history.page.map((event) => ({
          ...event,
          actor: event.actor
            ? { ...event.actor, image: normalizeMcpImage(event.actor.image) }
            : null,
        })),
      };
      return validateMcpResult(mcpPaginatedCircleHistorySchema, value);
    }

    if (args.operation.kind === "search_transactions") {
      const search = await searchTransactionsForUser(
        ctx,
        circleAuthz.value.access.circle._id,
        user,
        {
          ...(args.operation.filters === undefined ? {} : { filters: args.operation.filters }),
          ...(args.operation.page === undefined ? {} : { page: args.operation.page }),
          ...(args.operation.pageSize === undefined ? {} : { pageSize: args.operation.pageSize }),
          ...(args.operation.paginationOpts === undefined
            ? {}
            : { paginationOpts: args.operation.paginationOpts }),
        },
      );
      if (!search.ok) {
        return { ok: false as const, error: search.error };
      }
      return validateMcpResult(mcpSearchTransactionsResultSchema, search.value);
    }

    if (args.operation.kind === "get_transaction") {
      const value = await getTransactionForUser(
        ctx,
        circleAuthz.value.access.circle._id,
        args.operation.transactionRef,
        user,
      );
      if (!value) {
        return { ok: false as const, error: "transaction_inaccessible" as const };
      }
      return validateMcpResult(mcpTransactionDetailSchema, value);
    }

    if (args.operation.kind === "list_transaction_history") {
      const history = await listTransactionHistoryForUser(
        ctx,
        circleAuthz.value.access.circle._id,
        args.operation.transactionRef,
        user,
        args.operation.paginationOpts ?? { numItems: 50, cursor: null },
      );
      return validateMcpResult(mcpPaginatedTransactionHistorySchema, history);
    }

    if (args.operation.kind === "get_monthly_ledger") {
      const ledger = await getMonthlyLedgerForUser(ctx, circleAuthz.value.access.circle._id, user, {
        month: args.operation.month,
        ...(args.operation.paginationOpts === undefined
          ? {}
          : { paginationOpts: args.operation.paginationOpts }),
      });
      if (!ledger.ok) {
        return { ok: false as const, error: ledger.error };
      }
      return validateMcpResult(mcpMonthlyLedgerSchema, ledger.value);
    }

    if (args.operation.kind === "get_dashboard") {
      const dashboard = await getDashboardForUser(ctx, circleAuthz.value.access.circle._id, user, {
        month: args.operation.month,
      });
      if (!dashboard.ok) {
        return { ok: false as const, error: dashboard.error };
      }
      return validateMcpResult(mcpDashboardSchema, dashboard.value);
    }

    if (args.operation.kind === "get_monthly_comparison") {
      const comparison = await getMonthlyComparisonForUser(
        ctx,
        circleAuthz.value.access.circle._id,
        user,
        {
          endMonth: args.operation.endMonth,
          rangeMonths: args.operation.rangeMonths,
        },
      );
      if (!comparison.ok) {
        return { ok: false as const, error: comparison.error };
      }
      return validateMcpResult(mcpMonthlyComparisonSchema, comparison.value);
    }

    if (args.operation.kind === "get_category_analytics") {
      const analytics = await getCategoryAnalyticsForUser(
        ctx,
        circleAuthz.value.access.circle._id,
        user,
        {
          month: args.operation.month,
          type: args.operation.type,
          ...(args.operation.paginationOpts === undefined
            ? {}
            : { paginationOpts: args.operation.paginationOpts }),
        },
      );
      if (!analytics.ok) {
        return { ok: false as const, error: analytics.error };
      }
      return validateMcpResult(mcpCategoryAnalyticsSchema, analytics.value);
    }

    if (args.operation.kind === "list_categories") {
      const categories = await listCategoriesForUser(
        ctx,
        circleAuthz.value.access.circle._id,
        user,
        {
          ...(args.operation.filters === undefined ? {} : { filters: args.operation.filters }),
          ...(args.operation.paginationOpts === undefined
            ? {}
            : { paginationOpts: args.operation.paginationOpts }),
        },
      );
      return validateMcpResult(mcpPaginatedCategoriesSchema, categories);
    }

    if (args.operation.kind === "get_category") {
      const value = await getCategoryForUser(
        ctx,
        circleAuthz.value.access.circle._id,
        args.operation.categoryRef,
        user,
      );
      if (!value) {
        return { ok: false as const, error: "category_inaccessible" as const };
      }
      return validateMcpResult(mcpCategoryDetailSchema, value);
    }

    if (args.operation.kind === "list_category_transactions") {
      const transactions = await listCategoryTransactionsForUser(
        ctx,
        circleAuthz.value.access.circle._id,
        args.operation.categoryRef,
        user,
      );
      return validateMcpResult(mcpListCategoryTransactionsResultSchema, { transactions });
    }

    if (args.operation.kind === "list_category_history") {
      const history = await listCategoryHistoryForUser(
        ctx,
        circleAuthz.value.access.circle._id,
        args.operation.categoryRef,
        user,
        args.operation.paginationOpts ?? { numItems: 50, cursor: null },
      );
      return validateMcpResult(mcpPaginatedCategoryHistorySchema, history);
    }

    return { ok: false as const, error: "invalid_operation" as const };
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
  let totalRevoked = 0;
  while (totalRevoked < maxTotal) {
    const takeCount = Math.min(EXPIRED_CLEANUP_BATCH, maxTotal - totalRevoked);
    const expired = await ctx.db
      .query("mcpGrants")
      .withIndex("by_status_and_activation_expires", (q) =>
        q.eq("status", "pending").lte("activationExpiresAt", now),
      )
      .take(takeCount);
    if (expired.length === 0) {
      break;
    }
    let revokedThisBatch = 0;
    for (const row of expired) {
      const activationExpiresAt =
        row.activationExpiresAt ?? row.createdAt + MCP_PENDING_GRANT_TTL_MS;
      if (activationExpiresAt > now) {
        continue;
      }
      await revokeMcpGrant(ctx, { grantId: row._id, now });
      revokedThisBatch += 1;
    }
    totalRevoked += revokedThisBatch;
    if (expired.length < takeCount || revokedThisBatch === 0) {
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
