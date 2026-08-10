import { MUTATION_ERRORS, mutationErrorData } from "@spend-circle/domain";
import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import schema from "./schema.js";

// `resolveCircleAccess` folds in `getCurrentUserOrNull`, which is backed by the
// Better Auth component and cannot run under convex-test. We stub just that auth
// seam so the rest of the module — the missing≡inaccessible collapse and the
// capability derivation — is exercised against a real simulated db.
const { mockCurrentUser } = vi.hoisted(() => ({ mockCurrentUser: vi.fn() }));
vi.mock("./auth.js", () => ({ getCurrentUserOrNull: mockCurrentUser }));

const {
  getActiveMembership,
  requireCircleAccess,
  requireTransactionAccess,
  resolveCircleAccess,
  resolveCircleAccessForUser,
} = await import("./guard.js");

const modules = import.meta.glob("./**/*.ts");

interface Seed {
  user: Doc<"users">;
  circleId: Id<"circles">;
  ownerMemberId: Id<"members">;
}

/** Seeds a User who owns a Circle. `role`/`status`/circle status/setup are tunable. */
async function seed(
  ctx: MutationCtx,
  opts: {
    role?: "owner" | "member";
    status?: "active" | "removed";
    archived?: boolean;
    kind?: "personal" | "regular";
    setupCompletedAt?: number | null;
  } = {},
): Promise<Seed> {
  const now = Date.now();
  const userId = await ctx.db.insert("users", {
    email: "ada@example.com",
    displayName: "Ada Lovelace",
    acceptedTermsVersion: "2026-05-01",
    acceptedPrivacyVersion: "2026-05-01",
    acceptedAt: now,
    analyticsOptOut: false,
    onboardingCompletedAt: now,
    createdAt: now,
  });
  const kind = opts.kind ?? "personal";
  const setupCompletedAt =
    opts.setupCompletedAt !== undefined ? opts.setupCompletedAt : kind === "personal" ? now : null;
  const circleId = await ctx.db.insert("circles", {
    name: kind === "personal" ? "Personal" : "Trip",
    kind,
    currency: "USD",
    color: "blue",
    mark: kind === "personal" ? "P" : "T",
    ownerUserId: userId,
    status: opts.archived ? "archived" : "active",
    setupCompletedAt,
    currencyLocked: false,
    accountDeletionBlocked: false,
    createdAt: now,
  });
  const ownerMemberId = await ctx.db.insert("members", {
    circleId,
    userId,
    role: opts.role ?? "owner",
    status: opts.status ?? "active",
    displayName: "Ada Lovelace",
    joinedAt: now,
  });
  const user = await ctx.db.get(userId);
  if (!user) {
    throw new Error("seed failed");
  }
  return { user, circleId, ownerMemberId };
}

describe("getActiveMembership", () => {
  it("returns the membership when active, null when removed or absent", async () => {
    const t = convexTest(schema, modules);
    const { user, circleId } = await t.run((ctx) => seed(ctx, { status: "active" }));

    const active = await t.run((ctx) => getActiveMembership(ctx, circleId, user._id));
    expect(active?.role).toBe("owner");

    // A removed membership reads as no access.
    await t.run(async (ctx) => {
      const m = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) => q.eq("circleId", circleId).eq("userId", user._id))
        .unique();
      if (m) {
        await ctx.db.patch(m._id, { status: "removed" });
      }
    });
    const removed = await t.run((ctx) => getActiveMembership(ctx, circleId, user._id));
    expect(removed).toBeNull();

    const stranger = "k0000000000000000000000000000000" as Id<"users">;
    const none = await t.run((ctx) => getActiveMembership(ctx, circleId, stranger));
    expect(none).toBeNull();
  });
});

describe("resolveCircleAccess", () => {
  it("returns null for an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seed(ctx));
    mockCurrentUser.mockResolvedValue(null);

    const access = await t.run((ctx) => resolveCircleAccess(ctx, circleId));
    expect(access).toBeNull();
  });

  it("returns null when the Circle is missing (indistinguishable from inaccessible)", async () => {
    const t = convexTest(schema, modules);
    const { user } = await t.run((ctx) => seed(ctx));
    mockCurrentUser.mockResolvedValue(user);
    const ghost = "k0000000000000000000000000000000" as Id<"circles">;

    const access = await t.run((ctx) => resolveCircleAccess(ctx, ghost));
    expect(access).toBeNull();
  });

  it("returns null when the caller is not an active member", async () => {
    const t = convexTest(schema, modules);
    const { user, circleId } = await t.run((ctx) => seed(ctx, { status: "removed" }));
    mockCurrentUser.mockResolvedValue(user);

    const access = await t.run((ctx) => resolveCircleAccess(ctx, circleId));
    expect(access).toBeNull();
  });

  // The AuthorizedCircle carries a method (assertWritable), which is not a
  // serializable Convex value, so capabilities are asserted INSIDE t.run and only
  // primitives are returned.
  it("derives owner + writable capabilities for an active Circle's owner", async () => {
    const t = convexTest(schema, modules);
    const { user, circleId } = await t.run((ctx) => seed(ctx, { role: "owner" }));
    mockCurrentUser.mockResolvedValue(user);

    const result = await t.run(async (ctx) => {
      const access = await resolveCircleAccess(ctx, circleId);
      let threw = false;
      try {
        access?.assertWritable();
      } catch {
        threw = true;
      }
      return {
        found: access !== null,
        isOwner: access?.isOwner,
        isWritable: access?.isWritable,
        threw,
      };
    });
    expect(result).toEqual({ found: true, isOwner: true, isWritable: true, threw: false });
  });

  it("derives non-owner for a regular member", async () => {
    const t = convexTest(schema, modules);
    const { user, circleId } = await t.run((ctx) => seed(ctx, { role: "member" }));
    mockCurrentUser.mockResolvedValue(user);

    const isOwner = await t.run(async (ctx) => {
      const access = await resolveCircleAccess(ctx, circleId);
      return access?.isOwner ?? null;
    });
    expect(isOwner).toBe(false);
  });

  it("marks an archived Circle read-only and makes assertWritable throw", async () => {
    const t = convexTest(schema, modules);
    const { user, circleId } = await t.run((ctx) => seed(ctx, { archived: true }));
    mockCurrentUser.mockResolvedValue(user);

    const result = await t.run(async (ctx) => {
      const access = await resolveCircleAccess(ctx, circleId);
      let data: unknown = null;
      try {
        access?.assertWritable();
      } catch (error) {
        if (error instanceof ConvexError) {
          data = error.data;
        }
      }
      return { isWritable: access?.isWritable, data };
    });
    expect(result.isWritable).toBe(false);
    expect(result.data).toEqual(mutationErrorData(MUTATION_ERRORS.circleArchived));
  });

  it("assertSetupComplete rejects an incomplete regular Circle", async () => {
    const t = convexTest(schema, modules);
    const { user, circleId } = await t.run((ctx) =>
      seed(ctx, { kind: "regular", setupCompletedAt: null }),
    );
    mockCurrentUser.mockResolvedValue(user);

    const data = await t.run(async (ctx) => {
      const access = await resolveCircleAccess(ctx, circleId);
      try {
        access?.assertSetupComplete();
        return null;
      } catch (error) {
        if (error instanceof ConvexError) {
          return error.data;
        }
        throw error;
      }
    });
    expect(data).toEqual(mutationErrorData(MUTATION_ERRORS.circleSetupIncomplete));
  });

  it("assertSetupComplete allows a completed regular Circle", async () => {
    const t = convexTest(schema, modules);
    const { user, circleId } = await t.run((ctx) =>
      seed(ctx, { kind: "regular", setupCompletedAt: Date.now() }),
    );
    mockCurrentUser.mockResolvedValue(user);

    const threw = await t.run(async (ctx) => {
      const access = await resolveCircleAccess(ctx, circleId);
      try {
        access?.assertSetupComplete();
        return false;
      } catch {
        return true;
      }
    });
    expect(threw).toBe(false);
  });

  it("assertSetupComplete allows a Personal Circle", async () => {
    const t = convexTest(schema, modules);
    const { user, circleId } = await t.run((ctx) => seed(ctx, { kind: "personal" }));
    mockCurrentUser.mockResolvedValue(user);

    const threw = await t.run(async (ctx) => {
      const access = await resolveCircleAccess(ctx, circleId);
      try {
        access?.assertSetupComplete();
        return false;
      } catch {
        return true;
      }
    });
    expect(threw).toBe(false);
  });
});

describe("resolveCircleAccessForUser", () => {
  it("returns authorized access for an active member", async () => {
    const t = convexTest(schema, modules);
    const result = await t.run(async (ctx) => {
      const { user, circleId } = await seed(ctx);
      const access = await resolveCircleAccessForUser(ctx, circleId, user);
      return {
        found: access !== null,
        circleId: access?.circle._id,
        isOwner: access?.isOwner,
        isWritable: access?.isWritable,
      };
    });
    expect(result.found).toBe(true);
    expect(result.isOwner).toBe(true);
    expect(result.isWritable).toBe(true);
    expect(result.circleId).toBeTruthy();
  });

  it("returns null when the caller is not an active member", async () => {
    const t = convexTest(schema, modules);
    const access = await t.run(async (ctx) => {
      const { user, circleId } = await seed(ctx, { status: "removed" });
      return resolveCircleAccessForUser(ctx, circleId, user);
    });
    expect(access).toBeNull();
  });
});

describe("requireCircleAccess", () => {
  it("throws a generic 'Circle not found' when there is no access", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seed(ctx));
    mockCurrentUser.mockResolvedValue(null);

    await expect(t.run((ctx) => requireCircleAccess(ctx, circleId))).rejects.toThrow(
      "Circle not found",
    );
  });

  it("returns the AuthorizedCircle when access resolves", async () => {
    const t = convexTest(schema, modules);
    const { user, circleId } = await t.run((ctx) => seed(ctx));
    mockCurrentUser.mockResolvedValue(user);

    const result = await t.run(async (ctx) => {
      const access = await requireCircleAccess(ctx, circleId);
      return { circleId: access.circle._id, userId: access.membership.userId };
    });
    expect(result.circleId).toBe(circleId);
    expect(result.userId).toBe(user._id);
  });
});

describe("requireTransactionAccess", () => {
  /** Adds a second active member to the seeded circle and returns the User + member id. */
  async function addMember(
    ctx: MutationCtx,
    circleId: Id<"circles">,
  ): Promise<{ user: Doc<"users">; memberId: Id<"members"> }> {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {
      email: "grace@example.com",
      displayName: "Grace Hopper",
      acceptedTermsVersion: "2026-05-01",
      acceptedPrivacyVersion: "2026-05-01",
      acceptedAt: now,
      analyticsOptOut: false,
      onboardingCompletedAt: now,
      createdAt: now,
    });
    const memberId = await ctx.db.insert("members", {
      circleId,
      userId,
      role: "member",
      status: "active",
      displayName: "Grace Hopper",
      joinedAt: now,
    });
    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("seed failed");
    }
    return { user, memberId };
  }

  /** Inserts a minimal active Transaction recorded by `recordedByMemberId`. */
  async function makeTransaction(
    ctx: MutationCtx,
    circleId: Id<"circles">,
    recordedByMemberId: Id<"members">,
  ): Promise<Id<"transactions">> {
    const now = Date.now();
    return await ctx.db.insert("transactions", {
      circleId,
      type: "expense",
      title: "Lunch",
      amountMinorUnits: 1250,
      date: "2026-05-15",
      month: "2026-05",
      recordedByMemberId,
      paidByMemberId: recordedByMemberId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
  }

  it("marks the Recorded By Member as recorder and archiver", async () => {
    const t = convexTest(schema, modules);
    const { user, circleId, ownerMemberId } = await t.run((ctx) => seed(ctx, { role: "owner" }));
    const txnId = await t.run((ctx) => makeTransaction(ctx, circleId, ownerMemberId));
    mockCurrentUser.mockResolvedValue(user);

    const access = await t.run(async (ctx) => {
      const a = await requireTransactionAccess(ctx, txnId);
      return { isRecorder: a.isRecorder, canArchive: a.canArchive, txnId: a.transaction._id };
    });
    expect(access.isRecorder).toBe(true);
    expect(access.canArchive).toBe(true);
    expect(access.txnId).toBe(txnId);
  });

  it("lets the Owner archive but NOT edit another Member's Transaction", async () => {
    const t = convexTest(schema, modules);
    const { user: owner, circleId } = await t.run((ctx) => seed(ctx, { role: "owner" }));
    const other = await t.run((ctx) => addMember(ctx, circleId));
    const txnId = await t.run((ctx) => makeTransaction(ctx, circleId, other.memberId));
    mockCurrentUser.mockResolvedValue(owner);

    const access = await t.run(async (ctx) => {
      const a = await requireTransactionAccess(ctx, txnId);
      return { isRecorder: a.isRecorder, canArchive: a.canArchive };
    });
    expect(access.isRecorder).toBe(false); // can't edit fields
    expect(access.canArchive).toBe(true); // but may moderate (TXN-3)
  });

  it("a non-recorder Member is neither recorder nor archiver", async () => {
    const t = convexTest(schema, modules);
    const { circleId, ownerMemberId } = await t.run((ctx) => seed(ctx, { role: "owner" }));
    const other = await t.run((ctx) => addMember(ctx, circleId));
    const txnId = await t.run((ctx) => makeTransaction(ctx, circleId, ownerMemberId));
    mockCurrentUser.mockResolvedValue(other.user);

    const access = await t.run(async (ctx) => {
      const a = await requireTransactionAccess(ctx, txnId);
      return { isRecorder: a.isRecorder, canArchive: a.canArchive };
    });
    expect(access.isRecorder).toBe(false);
    expect(access.canArchive).toBe(false);
  });

  it("throws 'Transaction not found' for a missing Transaction", async () => {
    const t = convexTest(schema, modules);
    const { user } = await t.run((ctx) => seed(ctx));
    mockCurrentUser.mockResolvedValue(user);
    const ghost = "j0000000000000000000000000000000" as Id<"transactions">;

    await expect(t.run((ctx) => requireTransactionAccess(ctx, ghost))).rejects.toThrow(
      "Transaction not found",
    );
  });

  it("throws the SAME 'Transaction not found' for an inaccessible Circle (anti-enumeration)", async () => {
    const t = convexTest(schema, modules);
    const { circleId, ownerMemberId } = await t.run((ctx) => seed(ctx));
    const txnId = await t.run((ctx) => makeTransaction(ctx, circleId, ownerMemberId));
    // A non-member caller: missing and inaccessible must be indistinguishable.
    mockCurrentUser.mockResolvedValue(null);

    await expect(t.run((ctx) => requireTransactionAccess(ctx, txnId))).rejects.toThrow(
      "Transaction not found",
    );
  });
});
