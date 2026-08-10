import type { Doc, Id } from "../convex/_generated/dataModel.js";
import type { MutationCtx } from "../convex/_generated/server.js";
import { accountDeletionBlockerFields } from "../convex/accountDeletionBlockers.js";
import { generateInvitationToken, hashInvitationToken } from "../convex/invitationToken.js";
import { createUserWithPersonalCircle, type NewUserProfile } from "../convex/model.js";
import { syncTransactionSearchDocument } from "../convex/transactionSearchDocuments.js";

/**
 * Shared convex-test seeding (CLAUDE.md: one helper, not copy-pasted scaffolding
 * per test file). These insert rows directly through `ctx.db` so a test controls
 * the exact backend state — actor, lifecycle, dates, categories — without routing
 * through a mutation. They depend on nothing test-framework-specific (no `vi`, no
 * auth mock), so each test file still declares its own `vi.mock("./auth.js")` and
 * `import.meta.glob` (both must be hoisted/local) and shares only the row builders.
 *
 * Lives in `packages/convex/test/` (outside the deployed functions dir) so
 * `convex deploy` never analyzes test-only deps. Vitest does not treat this as a
 * suite (Vitest include for convex `*.test.ts` files only); it registers no Convex `query`/`mutation`.
 */

/** First-page pagination opts for a `paginate`d query (cursor reset). */
export const firstPage = (size: number) => ({ paginationOpts: { numItems: size, cursor: null } });

/** Args for {@link api.search.searchTransactions} numbered URL pages (#97). */
export const searchTransactionPage = (page: number, pageSize: number) => ({ page, pageSize });

export async function makeUser(
  ctx: MutationCtx,
  email: string,
  displayName: string,
): Promise<Doc<"users">> {
  const now = Date.now();
  const userId = await ctx.db.insert("users", {
    email,
    displayName,
    acceptedTermsVersion: "2026-05-01",
    acceptedPrivacyVersion: "2026-05-01",
    acceptedAt: now,
    analyticsOptOut: false,
    onboardingCompletedAt: now,
    createdAt: now,
  });
  const user = await ctx.db.get(userId);
  if (!user) {
    throw new Error("seed failed");
  }
  return user;
}

export interface Seed {
  owner: Doc<"users">;
  ownerMemberId: Id<"members">;
  circleId: Id<"circles">;
}

export interface PersonalCircleOwnerSeed {
  owner: Doc<"users">;
  userId: Id<"users">;
  personalCircleId: Id<"circles">;
}

/** Bootstraps a User + Personal Circle via {@link createUserWithPersonalCircle}. */
export async function seedPersonalCircleOwner(
  ctx: MutationCtx,
  opts: NewUserProfile & { onboarded?: boolean },
): Promise<PersonalCircleOwnerSeed> {
  const userId = await createUserWithPersonalCircle(ctx, {
    email: opts.email,
    displayName: opts.displayName,
    image: opts.image,
    currency: opts.currency,
  });
  const owner = await ctx.db.get(userId);
  if (!owner) {
    throw new Error("seed failed");
  }
  if (opts.onboarded) {
    await ctx.db.patch(userId, { onboardingCompletedAt: owner.createdAt });
  }
  const personal = await ctx.db
    .query("circles")
    .withIndex("by_owner_and_kind", (q) => q.eq("ownerUserId", userId).eq("kind", "personal"))
    .unique();
  if (!personal) {
    throw new Error("personal circle missing");
  }
  return { owner, userId, personalCircleId: personal._id };
}

/** Seeds an active regular Circle with an owner Member. */
export async function seedCircle(
  ctx: MutationCtx,
  opts: {
    archived?: boolean;
    kind?: "personal" | "regular";
    color?: string;
    currency?: string;
    currencyLocked?: boolean;
    setupCompletedAt?: number | null;
  } = {},
): Promise<Seed> {
  const now = Date.now();
  const owner = await makeUser(ctx, "owner@example.com", "Olive Owner");
  const kind = opts.kind ?? "regular";
  const status = opts.archived ? "archived" : "active";
  const setupCompletedAt =
    opts.setupCompletedAt !== undefined ? opts.setupCompletedAt : kind === "personal" ? now : null;
  const circleId = await ctx.db.insert("circles", {
    name: "Trip",
    kind,
    currency: opts.currency ?? "USD",
    color: opts.color ?? "blue",
    mark: "T",
    ownerUserId: owner._id,
    status,
    setupCompletedAt,
    currencyLocked: opts.currencyLocked ?? false,
    ...accountDeletionBlockerFields({ kind, status, setupCompletedAt }, 1),
    createdAt: now,
    ...(opts.archived ? { archivedAt: now } : {}),
  });
  const ownerMemberId = await ctx.db.insert("members", {
    circleId,
    userId: owner._id,
    role: "owner",
    status: "active",
    displayName: owner.displayName,
    joinedAt: now,
  });
  return { owner, ownerMemberId, circleId };
}

/** Adds a Member (active or removed) to a Circle and returns the User + member id. */
export async function addMember(
  ctx: MutationCtx,
  circleId: Id<"circles">,
  email: string,
  displayName: string,
  status: "active" | "removed" = "active",
): Promise<{ user: Doc<"users">; memberId: Id<"members"> }> {
  const user = await makeUser(ctx, email, displayName);
  const memberId = await ctx.db.insert("members", {
    circleId,
    userId: user._id,
    role: "member",
    status,
    displayName,
    joinedAt: Date.now(),
    ...(status === "removed" ? { removedAt: Date.now() } : {}),
  });
  const { recomputeAccountDeletionBlockers } = await import("../convex/accountDeletionBlockers.js");
  await recomputeAccountDeletionBlockers(ctx, circleId);
  return { user, memberId };
}

/** Inserts a Category directly and returns its id. */
export async function makeCategory(
  ctx: MutationCtx,
  circleId: Id<"circles">,
  opts: {
    name: string;
    type?: "expense" | "income";
    color?: string;
    status?: "active" | "archived";
    creatorUserId: Id<"users">;
  },
): Promise<Id<"categories">> {
  return await ctx.db.insert("categories", {
    circleId,
    name: opts.name,
    nameLower: opts.name.toLowerCase(),
    type: opts.type ?? "expense",
    color: opts.color ?? "green",
    creatorUserId: opts.creatorUserId,
    status: opts.status ?? "active",
    createdAt: Date.now(),
    ...(opts.status === "archived" ? { archivedAt: Date.now() } : {}),
  });
}

/** Marks a seeded Circle as setup-complete (test-only; outside deploy graph). */
export async function markCircleSetupComplete(ctx: MutationCtx, circleId: Id<"circles">) {
  await ctx.db.patch(circleId, { setupCompletedAt: Date.now() });
}

export interface Fixture extends Seed {
  groceriesId: Id<"categories">;
  diningId: Id<"categories">;
  salaryId: Id<"categories">;
}

/**
 * A Circle with the owner and a few categories of both types. Defaults to a
 * completed regular Circle because it immediately inserts Categories — incomplete
 * Circles must opt in via `setupCompletedAt: null` for defensive impossible-state tests.
 */
export async function seedFixture(
  ctx: MutationCtx,
  opts: {
    currency?: string;
    archived?: boolean;
    setupCompletedAt?: number | null;
  } = {},
): Promise<Fixture> {
  const seed = await seedCircle(ctx, {
    currency: opts.currency,
    archived: opts.archived,
    setupCompletedAt: opts.setupCompletedAt !== undefined ? opts.setupCompletedAt : Date.now(),
  });
  const groceriesId = await makeCategory(ctx, seed.circleId, {
    name: "Groceries",
    type: "expense",
    creatorUserId: seed.owner._id,
  });
  const diningId = await makeCategory(ctx, seed.circleId, {
    name: "Dining",
    type: "expense",
    creatorUserId: seed.owner._id,
  });
  const salaryId = await makeCategory(ctx, seed.circleId, {
    name: "Salary",
    type: "income",
    creatorUserId: seed.owner._id,
  });
  return { ...seed, groceriesId, diningId, salaryId };
}

/**
 * Inserts an active Transaction + its Category links directly, so tests control
 * `recordedBy`/`paidBy`/type/status/date/categories precisely without juggling the
 * create mutation's actor. Defaults: an expense recorded by the owner, categorized
 * Groceries, dated 2026-05-15.
 */
export async function seedTransaction(
  ctx: MutationCtx,
  f: Fixture,
  opts: {
    type?: "expense" | "income";
    title?: string;
    note?: string;
    amountMinorUnits?: number;
    date?: string;
    recordedByMemberId?: Id<"members">;
    paidByMemberId?: Id<"members">;
    categoryIds?: Id<"categories">[];
    status?: "active" | "archived";
    createdAt?: number;
  } = {},
): Promise<Id<"transactions">> {
  const now = opts.createdAt ?? Date.now();
  const recordedByMemberId = opts.recordedByMemberId ?? f.ownerMemberId;
  const date = opts.date ?? "2026-05-15";
  const status = opts.status ?? "active";
  const transactionId = await ctx.db.insert("transactions", {
    circleId: f.circleId,
    type: opts.type ?? "expense",
    title: opts.title ?? "Weekly shop",
    ...(opts.note ? { note: opts.note } : {}),
    amountMinorUnits: opts.amountMinorUnits ?? 1250,
    date,
    month: date.slice(0, 7),
    recordedByMemberId,
    paidByMemberId: opts.paidByMemberId ?? recordedByMemberId,
    status,
    createdAt: now,
    updatedAt: now,
    ...(status === "archived" ? { archivedAt: now } : {}),
  });
  for (const categoryId of opts.categoryIds ?? [f.groceriesId]) {
    await ctx.db.insert("transactionCategories", {
      circleId: f.circleId,
      transactionId,
      categoryId,
      transactionDate: date,
      transactionCreatedAt: now,
    });
  }
  const txn = await ctx.db.get(transactionId);
  if (!txn) {
    throw new Error("seed failed");
  }
  await syncTransactionSearchDocument(ctx, txn, {
    categoryIds: opts.categoryIds ?? [f.groceriesId],
  });
  return transactionId;
}

/** Bulk-inserts Transactions for cap/scale tests. Skips search sync by default (stream path). */
export async function seedTransactionsBulk(
  ctx: MutationCtx,
  f: Fixture,
  count: number,
  opts: { titlePrefix?: string; syncSearch?: boolean } = {},
) {
  const now = Date.now();
  const titlePrefix = opts.titlePrefix ?? "bulk";
  const syncSearch = opts.syncSearch ?? false;
  for (let index = 0; index < count; index += 1) {
    const day = ((index % 28) + 1).toString().padStart(2, "0");
    const date = `2026-06-${day}`;
    const transactionId = await ctx.db.insert("transactions", {
      circleId: f.circleId,
      type: "expense",
      title: `${titlePrefix} ${index}`,
      amountMinorUnits: 1250,
      date,
      month: date.slice(0, 7),
      recordedByMemberId: f.ownerMemberId,
      paidByMemberId: f.ownerMemberId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("transactionCategories", {
      circleId: f.circleId,
      transactionId,
      categoryId: f.groceriesId,
      transactionDate: date,
      transactionCreatedAt: now,
    });
    if (syncSearch) {
      const txn = await ctx.db.get(transactionId);
      if (txn) {
        await syncTransactionSearchDocument(ctx, txn, { categoryIds: [f.groceriesId] });
      }
    }
  }
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Inserts a feedback email send event for rate-limit tests (FBK-1). */
export async function seedFeedbackEmailEvent(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    type: "bug" | "feature" | "currency";
    sentAt: number;
  },
) {
  return await ctx.db.insert("feedbackEmailEvents", args);
}

/** Inserts an invitation email send event for rate-limit tests (ADR 0026). */
export async function seedInvitationEmailEvent(
  ctx: MutationCtx,
  args: {
    invitedByUserId: Id<"users">;
    circleId: Id<"circles">;
    emailLower: string;
    kind: "create" | "resend";
    sentAt: number;
  },
) {
  return await ctx.db.insert("invitationEmailEvents", args);
}

/** Inserts an invitation row directly for tests that need arbitrary states. */
export async function seedInvitation(
  ctx: MutationCtx,
  circleId: Id<"circles">,
  invitedByUserId: Id<"users">,
  opts: {
    email: string;
    status?: "pending" | "accepted" | "revoked" | "expired";
    expiresAt?: number;
    resendCount?: number;
    resendTimestamps?: number[];
    tokenHash?: string;
    createdAt?: number;
  },
): Promise<Id<"invitations">> {
  const now = Date.now();
  const token = generateInvitationToken();
  return await ctx.db.insert("invitations", {
    circleId,
    emailLower: opts.email.toLowerCase(),
    tokenHash: opts.tokenHash ?? (await hashInvitationToken(token)),
    status: opts.status ?? "pending",
    invitedByUserId,
    resendCount: opts.resendCount ?? 0,
    resendTimestamps: opts.resendTimestamps ?? [],
    createdAt: opts.createdAt ?? now,
    expiresAt: opts.expiresAt ?? now + INVITE_TTL_MS,
  });
}
