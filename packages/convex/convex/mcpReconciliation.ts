/**
 * Cross-store MCP grant reconciliation (#330).
 *
 * Convex revokes first (data access blocked). Worker KV cleanup is best-effort
 * with durable retries, bounded exhaustion, and scheduled orphan sweeps for
 * `pending_revoke` rows. Never reactivates a revoked grant.
 */

import {
  MCP_REVOCATION_TTL_MS,
  MCP_WORKER_CLEANUP_BACKOFF_BASE,
  MCP_WORKER_CLEANUP_BATCH_SIZE,
  MCP_WORKER_CLEANUP_INITIAL_BACKOFF_MS,
  MCP_WORKER_CLEANUP_MAX_ATTEMPTS,
  MCP_WORKER_CLEANUP_REQUEST_TIMEOUT_MS,
  signMcpRevocation,
} from "@pocketcircle/domain";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server.js";
import { currentMcpWorkerSecret, mcpWorkerOrigin } from "./mcpWorkerSecrets.js";
import { generateOpaqueToken } from "./opaqueToken.js";
import { reportTerminalFailure, sanitizeOperationalError } from "./terminalFailure.js";

function cleanupBackoffMs(attemptAfterFailure: number) {
  return (
    MCP_WORKER_CLEANUP_INITIAL_BACKOFF_MS *
    MCP_WORKER_CLEANUP_BACKOFF_BASE ** Math.max(0, attemptAfterFailure - 1)
  );
}

/** Schedule one Worker cleanup attempt for a revoked grant that still needs it. */
export async function enqueueMcpWorkerCleanup(
  ctx: MutationCtx,
  args: { grantId: Id<"mcpGrants">; delayMs?: number; force?: boolean },
) {
  await ctx.scheduler.runAfter(args.delayMs ?? 0, internal.mcpReconciliation.runWorkerCleanup, {
    grantId: args.grantId,
    force: args.force,
  });
}

function isCleanupDue(grant: Doc<"mcpGrants">, now: number) {
  if (grant.workerCleanupStatus !== "pending_revoke") {
    return false;
  }
  if (!grant.workerGrantId) {
    return true;
  }
  const next = grant.workerCleanupNextAttemptAt;
  return next === undefined || next <= now;
}

async function patchCleanupCompleted(ctx: MutationCtx, grantId: Id<"mcpGrants">, now: number) {
  await ctx.db.patch(grantId, {
    workerCleanupStatus: "completed",
    updatedAt: now,
    workerCleanupNextAttemptAt: undefined,
    workerCleanupLastError: undefined,
  });
}

export const getGrantForCleanup = internalQuery({
  args: { grantId: v.id("mcpGrants") },
  handler: async (ctx, args) => await ctx.db.get(args.grantId),
});

/**
 * Marks Worker cleanup complete for the exact revoked linkage. Accepts
 * `pending_revoke` and `exhausted` so a later manual/service retry can finish.
 */
export async function markMcpWorkerCleanupCompleted(
  ctx: MutationCtx,
  args: {
    grantId: Id<"mcpGrants"> | string;
    workerGrantId: string;
    principalId: string;
    now?: number;
  },
) {
  const id =
    typeof args.grantId === "string" ? ctx.db.normalizeId("mcpGrants", args.grantId) : args.grantId;
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
  if (grant.workerCleanupStatus !== "pending_revoke" && grant.workerCleanupStatus !== "exhausted") {
    return { ok: false as const, error: "cleanup_not_pending" as const };
  }
  await patchCleanupCompleted(ctx, grant._id, args.now ?? Date.now());
  return { ok: true as const };
}

/** Stale Convex row: revoked cleanup pending but no Worker grant to remove. */
export const completeOrphanedConvexCleanup = internalMutation({
  args: { grantId: v.id("mcpGrants"), now: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const grant = await ctx.db.get(args.grantId);
    if (grant?.workerCleanupStatus !== "pending_revoke") {
      return { ok: false as const, error: "not_pending" as const };
    }
    if (grant.workerGrantId) {
      return { ok: false as const, error: "has_worker_grant" as const };
    }
    const now = args.now ?? Date.now();
    await patchCleanupCompleted(ctx, grant._id, now);
    console.log("[mcp-reconcile] completed orphan convex cleanup", String(grant._id));
    return { ok: true as const };
  },
});

export const recordWorkerCleanupFailure = internalMutation({
  args: {
    grantId: v.id("mcpGrants"),
    error: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const grant = await ctx.db.get(args.grantId);
    if (grant?.workerCleanupStatus !== "pending_revoke") {
      return { ok: false as const, error: "not_pending" as const };
    }
    const now = args.now ?? Date.now();
    const attempts = (grant.workerCleanupAttempts ?? 0) + 1;
    const sanitized = sanitizeOperationalError(args.error);
    if (attempts >= MCP_WORKER_CLEANUP_MAX_ATTEMPTS) {
      await ctx.db.patch(grant._id, {
        workerCleanupStatus: "exhausted",
        workerCleanupAttempts: attempts,
        workerCleanupNextAttemptAt: undefined,
        workerCleanupLastError: sanitized,
        updatedAt: now,
      });
      await reportTerminalFailure(ctx, {
        kind: "mcp_worker_cleanup_exhausted",
        entityId: String(grant._id),
        error: sanitized,
      });
      console.log("[mcp-reconcile] cleanup exhausted", String(grant._id), attempts);
      return { ok: true as const, exhausted: true as const };
    }

    const delayMs = cleanupBackoffMs(attempts);
    await ctx.db.patch(grant._id, {
      workerCleanupAttempts: attempts,
      workerCleanupNextAttemptAt: now + delayMs,
      workerCleanupLastError: sanitized,
      updatedAt: now,
    });
    await enqueueMcpWorkerCleanup(ctx, { grantId: grant._id, delayMs });
    console.log("[mcp-reconcile] cleanup retry scheduled", String(grant._id), attempts, delayMs);
    return { ok: true as const, exhausted: false as const, delayMs };
  },
});

/**
 * Asks the Worker to revoke the linked OAuth grant, then Convex completes.
 * Fails closed on the Convex side — never flips status back to active.
 */
export const runWorkerCleanup = internalAction({
  args: { grantId: v.id("mcpGrants"), force: v.optional(v.boolean()) },
  handler: async (
    ctx,
    args,
    // Explicit return: TS circular inference via internal.mcpReconciliation.* calls.
  ): Promise<{ ok: true; alreadyComplete?: true } | { ok: false; error: string }> => {
    const grant = await ctx.runQuery(internal.mcpReconciliation.getGrantForCleanup, {
      grantId: args.grantId,
    });
    if (!grant) {
      return { ok: false, error: "grant_not_found" };
    }
    if (grant.status !== "revoked") {
      return { ok: false, error: "grant_not_revoked" };
    }
    if (grant.workerCleanupStatus === "completed") {
      return { ok: true, alreadyComplete: true };
    }
    if (grant.workerCleanupStatus === "exhausted") {
      return { ok: false, error: "cleanup_exhausted" };
    }
    if (grant.workerCleanupStatus !== "pending_revoke") {
      return { ok: false, error: "cleanup_not_pending" };
    }

    if (!grant.workerGrantId) {
      const orphaned = await ctx.runMutation(
        internal.mcpReconciliation.completeOrphanedConvexCleanup,
        { grantId: grant._id },
      );
      return orphaned.ok ? { ok: true } : { ok: false, error: orphaned.error };
    }

    const now = Date.now();
    if (!args.force && !isCleanupDue(grant, now)) {
      return { ok: false, error: "not_due" };
    }

    const origin = mcpWorkerOrigin();
    const secret = currentMcpWorkerSecret();
    if (!origin || !secret) {
      // Do not burn retry budget or re-enqueue — cron retries once configured.
      console.error(
        "[mcp-reconcile] missing MCP_WORKER_ORIGIN or HMAC; leaving pending",
        String(grant._id),
      );
      return { ok: false, error: "not_configured" };
    }

    const revocationToken = await signMcpRevocation(
      {
        v: 1,
        jti: generateOpaqueToken(),
        grantId: String(grant._id),
        principalId: grant.principalId,
        workerGrantId: grant.workerGrantId,
        iat: now,
        exp: now + MCP_REVOCATION_TTL_MS,
      },
      secret,
    );

    let response: Response;
    try {
      response = await fetch(new URL("/internal/revoke", origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revocationToken }),
        signal: AbortSignal.timeout(MCP_WORKER_CLEANUP_REQUEST_TIMEOUT_MS),
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "fetch_failed";
      await ctx.runMutation(internal.mcpReconciliation.recordWorkerCleanupFailure, {
        grantId: grant._id,
        error: message,
        now,
      });
      return { ok: false, error: "worker_unreachable" };
    }

    if (!response.ok) {
      await ctx.runMutation(internal.mcpReconciliation.recordWorkerCleanupFailure, {
        grantId: grant._id,
        error: `worker_http_${response.status}`,
        now,
      });
      return { ok: false, error: "worker_cleanup_failed" };
    }

    // Worker confirms via complete-revocation; re-check in case confirmation lagged.
    const after = await ctx.runQuery(internal.mcpReconciliation.getGrantForCleanup, {
      grantId: args.grantId,
    });
    if (after?.workerCleanupStatus === "completed") {
      console.log("[mcp-reconcile] cleanup completed", String(grant._id));
      return { ok: true };
    }

    const completed = await ctx.runMutation(internal.mcpReconciliation.markCleanupCompleted, {
      grantId: String(grant._id),
      workerGrantId: grant.workerGrantId,
      principalId: grant.principalId,
      now,
    });
    if (!completed.ok) {
      await ctx.runMutation(internal.mcpReconciliation.recordWorkerCleanupFailure, {
        grantId: grant._id,
        error: completed.error,
        now,
      });
      return { ok: false, error: completed.error };
    }
    console.log("[mcp-reconcile] cleanup completed", String(grant._id));
    return { ok: true };
  },
});

export const markCleanupCompleted = internalMutation({
  args: {
    grantId: v.string(),
    workerGrantId: v.string(),
    principalId: v.string(),
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => await markMcpWorkerCleanupCompleted(ctx, args),
});

/**
 * Scheduled orphan sweep: due `pending_revoke` rows (and revoked rows missing a
 * Worker grant id) get cleanup enqueued. Also backfills pre-#330 rows that lack
 * `workerCleanupNextAttemptAt` so the compound index cannot see them. Bounded
 * per run; continues via scheduler when the batch is full.
 */
export const reconcilePendingWorkerCleanups = internalMutation({
  args: { now: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const limit = Math.max(1, Math.min(args.limit ?? MCP_WORKER_CLEANUP_BATCH_SIZE, 100));

    async function processGrant(grant: Doc<"mcpGrants">) {
      if (!grant.workerGrantId) {
        await patchCleanupCompleted(ctx, grant._id, now);
        console.log("[mcp-reconcile] purged stale convex orphan", String(grant._id));
        return;
      }
      // Claim past this sweep's `now` so continuation cannot reselect the same page.
      await ctx.db.patch(grant._id, {
        workerCleanupNextAttemptAt: now + cleanupBackoffMs((grant.workerCleanupAttempts ?? 0) + 1),
        updatedAt: now,
      });
      await enqueueMcpWorkerCleanup(ctx, { grantId: grant._id, delayMs: 0, force: true });
    }

    let processed = 0;
    const due = await ctx.db
      .query("mcpGrants")
      .withIndex("by_worker_cleanup_status_and_next_attempt", (q) =>
        q.eq("workerCleanupStatus", "pending_revoke").lte("workerCleanupNextAttemptAt", now),
      )
      .take(limit);

    for (const grant of due) {
      if (!isCleanupDue(grant, now)) {
        continue;
      }
      await processGrant(grant);
      processed += 1;
    }

    // Legacy pending_revoke rows without nextAttemptAt are invisible to the
    // compound index — backfill and process until the batch is full.
    if (processed < limit) {
      const legacy = await ctx.db
        .query("mcpGrants")
        .withIndex("by_worker_cleanup_status", (q) => q.eq("workerCleanupStatus", "pending_revoke"))
        .take(limit);
      for (const grant of legacy) {
        if (processed >= limit) {
          break;
        }
        if (grant.workerCleanupNextAttemptAt !== undefined) {
          continue;
        }
        await ctx.db.patch(grant._id, { workerCleanupNextAttemptAt: now, updatedAt: now });
        await processGrant(grant);
        processed += 1;
      }
    }

    if (processed === limit || due.length === limit) {
      await ctx.scheduler.runAfter(0, internal.mcpReconciliation.reconcilePendingWorkerCleanups, {
        now,
        limit,
      });
    }
    console.log("[mcp-reconcile] orphan sweep processed", processed);
    return processed;
  },
});
