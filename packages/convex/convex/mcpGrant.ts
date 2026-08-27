/**
 * MCP grant lifecycle and authorization policy (#317).
 *
 * Convex owns the live PocketCircle grant. Future Worker bridge / consent
 * (#318) call these helpers; this ticket exposes no public MCP HTTP surface.
 *
 * Lifecycle: pending → active (with Worker linkage) → revoked. Invalid or
 * repeated transitions fail with no partial write. Authorization intersects
 * effective token scope, live grant scope, selected Circles, live membership,
 * and existing Circle app permissions — and never auto-expands Circles.
 */

import {
  type McpCirclePermission,
  type McpScope,
  mcpScopesInclude,
  normalizeMcpScopes,
} from "@pocketcircle/domain";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { type AuthorizedCircle, resolveCircleAccessForUser } from "./guard.js";
import { generateOpaqueToken } from "./opaqueToken.js";
import type { OperationReader } from "./operationReader.js";
import { resolveUserById } from "./operations.js";

export type McpClientDisplaySnapshot = {
  clientName?: string;
  clientUri?: string;
  logoUri?: string;
};

export type CreatePendingMcpGrantArgs = {
  userId: Id<"users">;
  clientId: string;
  clientDisplaySnapshot?: McpClientDisplaySnapshot;
  scopes: readonly string[];
  allowedCircleIds: readonly string[];
  now?: number;
};

export type McpGrantTransitionError =
  | "user_not_found"
  | "invalid_client"
  | "invalid_scopes"
  | "invalid_circles"
  | "grant_not_found"
  | "invalid_transition"
  | "worker_grant_required"
  | "principal_mismatch"
  | "worker_grant_conflict";

type TransitionOk<T> = { ok: true; value: T };
type TransitionErr = { ok: false; error: McpGrantTransitionError };
type TransitionResult<T> = TransitionOk<T> | TransitionErr;

function err(error: McpGrantTransitionError): TransitionErr {
  return { ok: false, error };
}

/**
 * Resolve Circle ids the User may put on a new grant. Every id must be a real
 * Circle the User currently accesses; any malformed/missing/inaccessible id
 * fails the whole create (no partial grant).
 */
async function resolveSelectableCircleIds(
  ctx: OperationReader,
  user: Doc<"users">,
  rawIds: readonly string[],
) {
  if (rawIds.length === 0) {
    return null;
  }
  const resolved: Id<"circles">[] = [];
  const seen = new Set<string>();
  for (const raw of rawIds) {
    if (seen.has(raw)) {
      continue;
    }
    seen.add(raw);
    const circleId = ctx.db.normalizeId("circles", raw);
    if (!circleId) {
      return null;
    }
    const access = await resolveCircleAccessForUser(ctx, circleId, user);
    if (!access) {
      return null;
    }
    resolved.push(circleId);
  }
  return resolved.length > 0 ? resolved : null;
}

/**
 * Create a pending grant after User consent. Does not link a Worker grant yet —
 * activation happens at OAuth token exchange.
 */
export async function createPendingMcpGrant(
  ctx: MutationCtx,
  args: CreatePendingMcpGrantArgs,
): Promise<TransitionResult<Doc<"mcpGrants">>> {
  const user = await resolveUserById(ctx, args.userId);
  if (!user) {
    return err("user_not_found");
  }
  if (args.clientId.trim() === "") {
    return err("invalid_client");
  }
  const scopes = normalizeMcpScopes(args.scopes);
  if (!scopes) {
    return err("invalid_scopes");
  }
  const allowedCircleIds = await resolveSelectableCircleIds(ctx, user, args.allowedCircleIds);
  if (!allowedCircleIds) {
    return err("invalid_circles");
  }

  const now = args.now ?? Date.now();
  const principalId = generateOpaqueToken();
  const grantId = await ctx.db.insert("mcpGrants", {
    userId: user._id,
    principalId,
    clientId: args.clientId,
    clientDisplaySnapshot: {
      clientName: args.clientDisplaySnapshot?.clientName,
      clientUri: args.clientDisplaySnapshot?.clientUri,
      logoUri: args.clientDisplaySnapshot?.logoUri,
    },
    scopes,
    allowedCircleIds,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    workerCleanupStatus: "none",
  });
  const grant = await ctx.db.get(grantId);
  if (!grant) {
    return err("grant_not_found");
  }
  return { ok: true, value: grant };
}

async function loadGrant(ctx: OperationReader, grantId: Id<"mcpGrants"> | string) {
  const id = typeof grantId === "string" ? ctx.db.normalizeId("mcpGrants", grantId) : grantId;
  if (!id) {
    return null;
  }
  return await ctx.db.get(id);
}

/**
 * Revoke one grant. Safe to call on already-revoked (idempotent success) so
 * account deletion and concurrent revoke do not partial-fail. Pending and
 * active both become revoked; Worker cleanup is marked when a Worker grant was
 * linked.
 */
export async function revokeMcpGrant(
  ctx: MutationCtx,
  args: { grantId: Id<"mcpGrants"> | string; now?: number },
): Promise<TransitionResult<Doc<"mcpGrants">>> {
  const grant = await loadGrant(ctx, args.grantId);
  if (!grant) {
    return err("grant_not_found");
  }
  if (grant.status === "revoked") {
    return { ok: true, value: grant };
  }

  const now = args.now ?? Date.now();
  const workerCleanupStatus =
    grant.workerGrantId !== undefined ? ("pending_revoke" as const) : ("none" as const);

  await ctx.db.patch(grant._id, {
    status: "revoked",
    updatedAt: now,
    revokedAt: now,
    workerCleanupStatus,
  });
  const revoked = await ctx.db.get(grant._id);
  if (!revoked) {
    return err("grant_not_found");
  }
  return { ok: true, value: revoked };
}

/**
 * Revoke every non-revoked grant for a User (Account Deletion). Must run in the
 * same mutation before async external cleanup so the next authz check fails closed.
 */
export async function revokeAllMcpGrantsForUser(
  ctx: MutationCtx,
  args: { userId: Id<"users">; now?: number },
) {
  const now = args.now ?? Date.now();
  const grants = await ctx.db
    .query("mcpGrants")
    .withIndex("by_user", (q) => q.eq("userId", args.userId))
    .collect();

  const revoked: Doc<"mcpGrants">[] = [];
  for (const grant of grants) {
    if (grant.status === "revoked") {
      continue;
    }
    const result = await revokeMcpGrant(ctx, { grantId: grant._id, now });
    if (result.ok) {
      revoked.push(result.value);
    }
  }
  return revoked;
}

/**
 * Supersede older pending/active grants for the same User+client when a new
 * grant activates (mirrors Cloudflare default grant replacement).
 */
async function supersedeSiblingGrants(
  ctx: MutationCtx,
  args: { userId: Id<"users">; clientId: string; keepGrantId: Id<"mcpGrants">; now: number },
) {
  for (const status of ["pending", "active"] as const) {
    const siblings = await ctx.db
      .query("mcpGrants")
      .withIndex("by_user_client_and_status", (q) =>
        q.eq("userId", args.userId).eq("clientId", args.clientId).eq("status", status),
      )
      .collect();
    for (const sibling of siblings) {
      if (sibling._id === args.keepGrantId) {
        continue;
      }
      await revokeMcpGrant(ctx, { grantId: sibling._id, now: args.now });
    }
  }
}

export type ActivateMcpGrantArgs = {
  grantId: Id<"mcpGrants"> | string;
  workerGrantId: string;
  /** Must match the pending grant's opaque principal (Worker OAuth userId). */
  principalId: string;
  now?: number;
};

/**
 * Activate a pending grant by linking the Worker OAuth grant. Fails closed on
 * wrong status, principal mismatch, empty Worker id, or Worker grant id already
 * linked to another Convex grant. On success only, supersedes other pending/
 * active grants for the same User+client (Cloudflare-style replacement) so a
 * failed activation never revokes siblings.
 */
export async function activateMcpGrant(
  ctx: MutationCtx,
  args: ActivateMcpGrantArgs,
): Promise<TransitionResult<Doc<"mcpGrants">>> {
  const workerGrantId = args.workerGrantId.trim();
  if (workerGrantId === "") {
    return err("worker_grant_required");
  }

  const grant = await loadGrant(ctx, args.grantId);
  if (!grant) {
    return err("grant_not_found");
  }
  if (grant.status !== "pending") {
    return err("invalid_transition");
  }
  if (grant.principalId !== args.principalId) {
    return err("principal_mismatch");
  }

  const existingForWorkerGrant = await ctx.db
    .query("mcpGrants")
    .withIndex("by_worker_grant", (q) => q.eq("workerGrantId", workerGrantId))
    .unique();
  if (existingForWorkerGrant && existingForWorkerGrant._id !== grant._id) {
    return err("worker_grant_conflict");
  }

  // Re-read immediately before the write — concurrent revoke must win without
  // sibling side effects.
  const pending = await ctx.db.get(grant._id);
  if (pending?.status !== "pending") {
    return err("invalid_transition");
  }

  const now = args.now ?? Date.now();
  await ctx.db.patch(grant._id, {
    status: "active",
    workerGrantId,
    activatedAt: now,
    updatedAt: now,
    workerCleanupStatus: "none",
  });
  const active = await ctx.db.get(grant._id);
  if (!active || active.status !== "active") {
    return err("invalid_transition");
  }

  await supersedeSiblingGrants(ctx, {
    userId: active.userId,
    clientId: active.clientId,
    keepGrantId: active._id,
    now,
  });

  return { ok: true, value: active };
}

export async function recordMcpGrantUse(
  ctx: MutationCtx,
  args: { grantId: Id<"mcpGrants">; now?: number },
) {
  const now = args.now ?? Date.now();
  await ctx.db.patch(args.grantId, { lastUsedAt: now, updatedAt: now });
}

/** Why authorization denied — Worker maps these to tool / OAuth errors. */
export type McpAuthzDenial =
  | {
      kind: "grant_unavailable";
      /** Present when the row exists but is not active. */
      status?: "pending" | "revoked";
    }
  | {
      kind: "insufficient_scope";
      requiredScope: McpScope;
      /** Grant itself lacks the scope → consent/reauth can fix. */
      grantLacksScope: boolean;
      /**
       * True when obtaining another OAuth scope (token step-up or reauth) could
       * fix this denial. False for app-permission / Circle denials.
       */
      scopeCouldFix: true;
    }
  | {
      kind: "circle_inaccessible";
      /** Deselected, malformed, missing, or no live membership — uniform. */
    }
  | {
      kind: "permission_denied";
      /** Live Member but lacks the required app permission (e.g. Owner-only). */
      requiredPermission: McpCirclePermission;
      scopeCouldFix: false;
    };

export type McpAuthzSuccess = {
  grant: Doc<"mcpGrants">;
  user: Doc<"users">;
};

export type McpCircleAuthzSuccess = McpAuthzSuccess & {
  access: AuthorizedCircle;
};

export type McpAuthzResult<T> = { ok: true; value: T } | { ok: false; denial: McpAuthzDenial };

function deny(denial: McpAuthzDenial): { ok: false; denial: McpAuthzDenial } {
  return { ok: false, denial };
}

/**
 * Authorize a non-Circle MCP operation (e.g. current User). Requires an active
 * grant and the required scope on both the effective token and the live grant.
 */
export async function authorizeMcpGrant(
  ctx: OperationReader,
  args: {
    grantId: Id<"mcpGrants"> | string;
    effectiveScopes: readonly string[];
    requiredScope: McpScope;
  },
): Promise<McpAuthzResult<McpAuthzSuccess>> {
  const grant = await loadGrant(ctx, args.grantId);
  if (!grant) {
    return deny({ kind: "grant_unavailable" });
  }
  if (grant.status !== "active") {
    return deny({
      kind: "grant_unavailable",
      status: grant.status === "pending" ? "pending" : "revoked",
    });
  }

  const grantHasScope = mcpScopesInclude(grant.scopes, args.requiredScope);
  const tokenHasScope = mcpScopesInclude(args.effectiveScopes, args.requiredScope);
  if (!grantHasScope || !tokenHasScope) {
    return deny({
      kind: "insufficient_scope",
      requiredScope: args.requiredScope,
      grantLacksScope: !grantHasScope,
      scopeCouldFix: true,
    });
  }

  const user = await resolveUserById(ctx, grant.userId);
  if (!user) {
    // User gone (deletion race) — treat as unavailable grant, not a Circle leak.
    return deny({ kind: "grant_unavailable", status: "revoked" });
  }

  return { ok: true, value: { grant, user } };
}

/**
 * Authorize a Circle-scoped MCP operation. Failures for deselected, malformed,
 * missing, or membership-lost Circles share {@link McpAuthzDenial} `circle_inaccessible`
 * so callers cannot probe existence. Owner-only app denials are distinct and never
 * suggest OAuth reauthorization.
 */
export async function authorizeMcpGrantForCircle(
  ctx: OperationReader,
  args: {
    grantId: Id<"mcpGrants"> | string;
    effectiveScopes: readonly string[];
    requiredScope: McpScope;
    circleId: string;
    requiredPermission: McpCirclePermission;
  },
): Promise<McpAuthzResult<McpCircleAuthzSuccess>> {
  const base = await authorizeMcpGrant(ctx, args);
  if (!base.ok) {
    return base;
  }

  const { grant, user } = base.value;
  const circleId = ctx.db.normalizeId("circles", args.circleId);
  if (!circleId) {
    return deny({ kind: "circle_inaccessible" });
  }

  const selected = grant.allowedCircleIds.some((id) => id === circleId);
  if (!selected) {
    return deny({ kind: "circle_inaccessible" });
  }

  const access = await resolveCircleAccessForUser(ctx, circleId, user);
  if (!access) {
    return deny({ kind: "circle_inaccessible" });
  }

  if (args.requiredPermission === "owner" && !access.isOwner) {
    return deny({
      kind: "permission_denied",
      requiredPermission: "owner",
      scopeCouldFix: false,
    });
  }

  return { ok: true, value: { grant, user, access } };
}
