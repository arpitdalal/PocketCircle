import { buildRef } from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mutateAndDrain } from "../test/mutateAndDrain.js";
import { registerEmailWorkpool } from "../test/registerEmailWorkpool.js";
import {
  addMember,
  makeCategory,
  makeUser,
  seedOwnedCircle,
  seedPersonalCircleOwner,
} from "../test/seed.js";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { circleEntity, recordEvent } from "./history.js";
import { generateInvitationToken, hashInvitationToken } from "./invitationToken.js";
import schema from "./schema.js";

const { mockCurrentUser } = vi.hoisted(() => ({ mockCurrentUser: vi.fn() }));
vi.mock("./auth.js", () => ({
  getCurrentUserOrNull: mockCurrentUser,
  requireCurrentUser: async (ctx: unknown) => {
    const user = await mockCurrentUser(ctx);
    if (!user) {
      throw new Error("Not authenticated");
    }
    return user;
  },
}));

const modules = import.meta.glob("./**/*.ts");

function createTestConvex() {
  const t = convexTest(schema, modules);
  registerEmailWorkpool(t);
  return t;
}

beforeEach(() => {
  mockCurrentUser.mockReset();
});

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function seedPendingInvitation(
  ctx: MutationCtx,
  opts: {
    circleId: Id<"circles">;
    email: string;
    invitedByUserId: Id<"users">;
    expiresAt?: number;
  },
) {
  const token = generateInvitationToken();
  await ctx.db.insert("invitations", {
    circleId: opts.circleId,
    emailLower: opts.email.toLowerCase(),
    tokenHash: await hashInvitationToken(token),
    status: "pending",
    invitedByUserId: opts.invitedByUserId,
    resendCount: 0,
    resendTimestamps: [],
    createdAt: Date.now(),
    expiresAt: opts.expiresAt ?? Date.now() + INVITE_TTL_MS,
  });
  return token;
}

async function activationRows(ctx: MutationCtx, userId: Id<"users">) {
  return await ctx.db
    .query("userActivation")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
}

async function seedOnboardedOwner(ctx: MutationCtx) {
  return await seedPersonalCircleOwner(ctx, {
    email: "ada@example.com",
    displayName: "Ada Lovelace",
    onboarded: true,
  });
}

describe("getActivationChecklist", () => {
  it("rejects an unauthenticated caller", async () => {
    const t = createTestConvex();
    mockCurrentUser.mockResolvedValue(null);
    await expect(t.query(api.activation.getActivationChecklist, {})).rejects.toThrow(
      "Not authenticated",
    );
  });

  it("returns uninitialized when the User has no row", async () => {
    const t = createTestConvex();
    const user = await t.run((ctx) => makeUser(ctx, "legacy@example.com", "Legacy"));
    mockCurrentUser.mockResolvedValue(user);

    expect(await t.query(api.activation.getActivationChecklist, {})).toEqual({
      status: "uninitialized",
    });
  });

  it("is User-scoped and omits invitee email, Invitation id, Member id, and internal Circle id", async () => {
    const t = createTestConvex();
    const { owner, userId } = await t.run((ctx) => seedOnboardedOwner(ctx));
    const inviteeEmail = "maya.invitee@secret.example";
    await t.run(async (ctx) => {
      const { circleId } = await seedOwnedCircle(ctx, owner, {
        name: "Cabin",
        setupCompletedAt: Date.now(),
      });
      await seedPendingInvitation(ctx, {
        circleId,
        email: inviteeEmail,
        invitedByUserId: userId,
      });
    });
    mockCurrentUser.mockResolvedValue(owner);

    const view = await t.query(api.activation.getActivationChecklist, {});
    expect(view.status).toBe("ready");
    if (view.status !== "ready") {
      throw new Error("expected ready checklist");
    }
    expect(view.sharedMemberState).toBe("pending");
    expect(view.pendingInvitationExpiresAt).toEqual(expect.any(Number));
    expect(view.memberCta).toEqual({
      kind: "members",
      circleRef: expect.stringMatching(/^cabin-/),
    });

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(inviteeEmail);
    expect(serialized).not.toContain("@secret.example");
    expect(view).not.toHaveProperty("circleId");
    expect(view).not.toHaveProperty("invitationId");
    expect(view).not.toHaveProperty("memberId");
    expect(view).not.toHaveProperty("userId");

    const stranger = await t.run((ctx) => makeUser(ctx, "other@example.com", "Other"));
    mockCurrentUser.mockResolvedValue(stranger);
    expect(await t.query(api.activation.getActivationChecklist, {})).toEqual({
      status: "uninitialized",
    });
  });
});

describe("initializeActivationChecklist", () => {
  it("bootstraps an empty row for New Users without fabricating completion", async () => {
    const t = createTestConvex();
    const { owner } = await t.run((ctx) => seedOnboardedOwner(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    const view = await t.query(api.activation.getActivationChecklist, {});
    expect(view).toMatchObject({
      status: "ready",
      visible: true,
      dismissed: false,
      allComplete: false,
      completedCount: 0,
      total: 4,
      personalTransactionComplete: false,
      personalCategoryComplete: false,
      regularCircleComplete: false,
      sharedMemberState: "not_started",
      pendingInvitationExpiresAt: null,
      firstIncomplete: "personalTransaction",
      memberCta: { kind: "create" },
      completionEventPending: false,
    });
  });

  it("backfills existing-User evidence without overwriting progress or dismissal", async () => {
    const t = createTestConvex();
    const owner = await t.run((ctx) => makeUser(ctx, "legacy@example.com", "Legacy User"));
    const categoryCreatedAt = 1_700_000_000_000;
    const txnCreatedAt = 1_700_000_100_000;
    const circleCreatedAt = 1_700_000_200_000;
    const inviteCreatedAt = 1_700_000_300_000;

    await t.run(async (ctx) => {
      const personal = await seedOwnedCircle(ctx, owner, {
        kind: "personal",
        name: "Legacy's Circle",
        createdAt: 1_699_000_000_000,
      });
      await ctx.db.insert("categories", {
        circleId: personal.circleId,
        name: "Coffee",
        nameLower: "coffee",
        type: "expense",
        color: "green",
        creatorUserId: owner._id,
        status: "archived",
        createdAt: categoryCreatedAt,
        archivedAt: categoryCreatedAt + 1,
      });
      await ctx.db.insert("transactions", {
        circleId: personal.circleId,
        type: "expense",
        title: "Latte",
        amountMinorUnits: 500,
        date: "2026-01-15",
        month: "2026-01",
        recordedByMemberId: personal.ownerMemberId,
        paidByMemberId: personal.ownerMemberId,
        status: "active",
        createdAt: txnCreatedAt,
        updatedAt: txnCreatedAt,
      });
      await ctx.db.patch(personal.circleId, { currencyLocked: true });

      const regular = await seedOwnedCircle(ctx, owner, {
        name: "Legacy Trip",
        setupCompletedAt: circleCreatedAt,
        createdAt: circleCreatedAt,
      });
      const ownerMembership = await ctx.db.get(regular.ownerMemberId);
      await recordEvent(ctx, {
        entity: circleEntity(regular.circleId),
        actor: ownerMembership,
        action: "created",
        changes: [{ field: "name", to: "Legacy Trip" }],
      });
      await ctx.db.insert("invitations", {
        circleId: regular.circleId,
        emailLower: "joined@example.com",
        tokenHash: await hashInvitationToken(generateInvitationToken()),
        status: "accepted",
        invitedByUserId: owner._id,
        resendCount: 0,
        resendTimestamps: [],
        createdAt: inviteCreatedAt,
        expiresAt: inviteCreatedAt + INVITE_TTL_MS,
      });
    });

    mockCurrentUser.mockResolvedValue(owner);
    await t.mutation(api.activation.initializeActivationChecklist, {});

    const view = await t.query(api.activation.getActivationChecklist, {});
    expect(view).toMatchObject({
      status: "ready",
      allComplete: true,
      completedCount: 4,
      personalTransactionComplete: true,
      personalCategoryComplete: true,
      regularCircleComplete: true,
      sharedMemberState: "complete",
      visible: false,
      firstIncomplete: null,
      completionEventPending: true,
    });

    await t.run(async (ctx) => {
      const [row] = await activationRows(ctx, owner._id);
      expect(row?.personalCategoryCreatedAt).toBe(categoryCreatedAt);
      expect(row?.personalTransactionCreatedAt).toBe(txnCreatedAt);
      expect(row?.regularCircleCreatedAt).toBe(circleCreatedAt);
      expect(row?.sharedMemberJoinedAt).toBe(inviteCreatedAt);
    });

    await t.mutation(api.activation.skipActivationChecklist, {});
    const dismissedAt = await t.run(async (ctx) => {
      const [row] = await activationRows(ctx, owner._id);
      return row?.dismissedAt;
    });
    expect(dismissedAt).toBeTypeOf("number");

    await t.mutation(api.activation.initializeActivationChecklist, {});
    await t.run(async (ctx) => {
      const [row] = await activationRows(ctx, owner._id);
      expect(row?.dismissedAt).toBe(dismissedAt);
      expect(row?.personalCategoryCreatedAt).toBe(categoryCreatedAt);
    });
  });

  it("does not credit transferred ownership or co-members invited by a previous Owner", async () => {
    const t = createTestConvex();
    const creator = await t.run((ctx) => makeUser(ctx, "creator@example.com", "Creator"));
    const recipient = await t.run((ctx) => makeUser(ctx, "recipient@example.com", "Recipient"));

    await t.run(async (ctx) => {
      const regular = await seedOwnedCircle(ctx, creator, {
        name: "Handed Off",
        setupCompletedAt: Date.now(),
      });
      const creatorMembership = await ctx.db.get(regular.ownerMemberId);
      await recordEvent(ctx, {
        entity: circleEntity(regular.circleId),
        actor: creatorMembership,
        action: "created",
        changes: [{ field: "name", to: "Handed Off" }],
      });
      await ctx.db.insert("invitations", {
        circleId: regular.circleId,
        emailLower: "prior@example.com",
        tokenHash: await hashInvitationToken(generateInvitationToken()),
        status: "accepted",
        invitedByUserId: creator._id,
        resendCount: 0,
        resendTimestamps: [],
        createdAt: Date.now(),
        expiresAt: Date.now() + INVITE_TTL_MS,
      });
      // Recipient receives ownership of a Circle with an active co-Member they never
      // invited and never created — both milestones must stay incomplete for them.
      await addMember(ctx, regular.circleId, "prior@example.com", "Prior");
      await ctx.db.patch(regular.ownerMemberId, { role: "member" });
      await ctx.db.insert("members", {
        circleId: regular.circleId,
        userId: recipient._id,
        role: "owner",
        status: "active",
        displayName: recipient.displayName,
        joinedAt: Date.now(),
      });
      await ctx.db.patch(regular.circleId, { ownerUserId: recipient._id });
    });

    mockCurrentUser.mockResolvedValue(recipient);
    await t.mutation(api.activation.initializeActivationChecklist, {});
    expect(await t.query(api.activation.getActivationChecklist, {})).toMatchObject({
      regularCircleComplete: false,
      sharedMemberState: "not_started",
      completedCount: 0,
    });

    mockCurrentUser.mockResolvedValue(creator);
    await t.mutation(api.activation.initializeActivationChecklist, {});
    expect(await t.query(api.activation.getActivationChecklist, {})).toMatchObject({
      regularCircleComplete: true,
      sharedMemberState: "complete",
      completedCount: 2,
    });
  });

  it("collapses concurrent duplicate rows by merging earliest timestamps", async () => {
    const t = createTestConvex();
    const { owner, userId } = await t.run((ctx) => seedOnboardedOwner(ctx));
    await t.run(async (ctx) => {
      const existing = await activationRows(ctx, userId);
      for (const row of existing) {
        await ctx.db.delete(row._id);
      }
      await ctx.db.insert("userActivation", {
        userId,
        initializedAt: 100,
        personalCategoryCreatedAt: 500,
        dismissedAt: 800,
      });
      await ctx.db.insert("userActivation", {
        userId,
        initializedAt: 50,
        personalTransactionCreatedAt: 200,
        personalCategoryCreatedAt: 400,
        completionEventDeliveredAt: 900,
      });
    });
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.activation.initializeActivationChecklist, {});

    await t.run(async (ctx) => {
      const rows = await activationRows(ctx, userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.initializedAt).toBe(50);
      expect(rows[0]?.personalTransactionCreatedAt).toBe(200);
      expect(rows[0]?.personalCategoryCreatedAt).toBe(400);
      expect(rows[0]?.dismissedAt).toBe(800);
      expect(rows[0]?.completionEventDeliveredAt).toBe(900);
      expect(rows[0]?.evidenceBackfilledAt).toEqual(expect.any(Number));
    });
  });
});

describe("activation writers", () => {
  it("marks milestones without running evidence backfill on the write path", async () => {
    const t = createTestConvex();
    const owner = await t.run((ctx) => makeUser(ctx, "hotpath@example.com", "Hot Path"));
    const personal = await t.run((ctx) =>
      seedOwnedCircle(ctx, owner, { kind: "personal", name: "Hot Path's Circle" }),
    );
    const categoryId = await t.run((ctx) =>
      makeCategory(ctx, personal.circleId, {
        name: "Coffee",
        creatorUserId: owner._id,
      }),
    );
    // Pre-existing category evidence that must NOT be scanned during createTransaction.
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.transactions.createTransaction, {
      circleId: personal.circleId,
      type: "expense",
      title: "Latte",
      amountMinorUnits: 500,
      date: "2026-05-15",
      categoryIds: [categoryId],
    });

    await t.run(async (ctx) => {
      const [row] = await activationRows(ctx, owner._id);
      expect(row?.personalTransactionCreatedAt).toEqual(expect.any(Number));
      expect(row?.personalCategoryCreatedAt).toBeUndefined();
      expect(row?.evidenceBackfilledAt).toBeUndefined();
    });
    expect(await t.query(api.activation.getActivationChecklist, {})).toEqual({
      status: "uninitialized",
    });

    await t.mutation(api.activation.initializeActivationChecklist, {});
    expect(await t.query(api.activation.getActivationChecklist, {})).toMatchObject({
      status: "ready",
      personalTransactionComplete: true,
      personalCategoryComplete: true,
      completedCount: 2,
    });
  });

  it("marks a Personal Transaction and ignores a regular-Circle Transaction", async () => {
    const t = createTestConvex();
    const { owner, personalCircleId } = await t.run((ctx) => seedOnboardedOwner(ctx));
    const personalCategoryId = await t.run((ctx) =>
      makeCategory(ctx, personalCircleId, {
        name: "Snacks",
        creatorUserId: owner._id,
      }),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.transactions.createTransaction, {
      circleId: personalCircleId,
      type: "expense",
      title: "Chips",
      amountMinorUnits: 250,
      date: "2026-05-15",
      categoryIds: [personalCategoryId],
    });

    expect(await t.query(api.activation.getActivationChecklist, {})).toMatchObject({
      personalTransactionComplete: true,
      personalCategoryComplete: false,
      completedCount: 1,
    });

    const regularId = await t.mutation(api.circles.createCircle, {
      name: "Cabin",
      currency: "USD",
      color: "blue",
      mark: "C",
    });
    await t.mutation(api.circles.completeCircleSetup, { circleId: regularId, answers: {} });
    const regularCategoryId = await t.run((ctx) =>
      makeCategory(ctx, regularId, { name: "Gas", creatorUserId: owner._id }),
    );
    await t.mutation(api.transactions.createTransaction, {
      circleId: regularId,
      type: "expense",
      title: "Fuel",
      amountMinorUnits: 4000,
      date: "2026-05-16",
      categoryIds: [regularCategoryId],
    });

    expect(await t.query(api.activation.getActivationChecklist, {})).toMatchObject({
      personalTransactionComplete: true,
      personalCategoryComplete: false,
      regularCircleComplete: true,
      completedCount: 2,
    });
  });

  it("marks a Personal Category create, including inline, and ignores regular starter seeding", async () => {
    const t = createTestConvex();
    const { owner, personalCircleId } = await t.run((ctx) => seedOnboardedOwner(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.categories.createCategory, {
      circleId: personalCircleId,
      name: "Coffee",
      type: "expense",
      color: "green",
    });
    expect(await t.query(api.activation.getActivationChecklist, {})).toMatchObject({
      personalCategoryComplete: true,
      completedCount: 1,
    });

    const regularId = await t.mutation(api.circles.createCircle, {
      name: "Flat",
      currency: "USD",
      color: "blue",
      mark: "F",
    });
    await t.mutation(api.circles.completeCircleSetup, {
      circleId: regularId,
      answers: { purpose: "residence", residenceType: "leased" },
    });

    const afterSetup = await t.query(api.activation.getActivationChecklist, {});
    expect(afterSetup).toMatchObject({
      personalCategoryComplete: true,
      regularCircleComplete: true,
      completedCount: 2,
    });
  });

  it("marks regular Circle create after the owner membership exists", async () => {
    const t = createTestConvex();
    const { owner } = await t.run((ctx) => seedOnboardedOwner(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    const circleId = await t.mutation(api.circles.createCircle, {
      name: "Roadtrip",
      currency: "USD",
      color: "teal",
      mark: "R",
    });
    expect(circleId).toEqual(expect.any(String));
    expect(await t.query(api.activation.getActivationChecklist, {})).toMatchObject({
      regularCircleComplete: true,
      memberCta: { kind: "setup", circleRef: expect.stringMatching(/^roadtrip-/) },
      completedCount: 1,
    });
  });

  it("completes the Member milestone only when the invitee accepts, not on pending", async () => {
    const t = createTestConvex();
    const { owner } = await t.run((ctx) => seedOnboardedOwner(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    const circleId = await t.mutation(api.circles.createCircle, {
      name: "Studio",
      currency: "USD",
      color: "blue",
      mark: "S",
    });
    await t.mutation(api.circles.completeCircleSetup, { circleId, answers: {} });

    const invitee = await t.run((ctx) => makeUser(ctx, "invitee@example.com", "Ivy Invitee"));
    const token = await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId,
        email: invitee.email,
        invitedByUserId: owner._id,
      }),
    );

    mockCurrentUser.mockResolvedValue(owner);
    expect(await t.query(api.activation.getActivationChecklist, {})).toMatchObject({
      sharedMemberState: "pending",
      regularCircleComplete: true,
      allComplete: false,
      memberCta: { kind: "members", circleRef: expect.stringMatching(/^studio-/) },
    });

    mockCurrentUser.mockResolvedValue(invitee);
    await mutateAndDrain(t, () => t.mutation(api.invitations.acceptInvitation, { token }));

    mockCurrentUser.mockResolvedValue(owner);
    expect(await t.query(api.activation.getActivationChecklist, {})).toMatchObject({
      sharedMemberState: "complete",
      allComplete: false,
      completedCount: 2,
    });
  });

  it("does not complete the Member milestone from an expired pending Invitation", async () => {
    const t = createTestConvex();
    const { owner } = await t.run((ctx) => seedOnboardedOwner(ctx));
    mockCurrentUser.mockResolvedValue(owner);
    const circleId = await t.mutation(api.circles.createCircle, {
      name: "Expired",
      currency: "USD",
      color: "blue",
      mark: "E",
    });
    await t.mutation(api.circles.completeCircleSetup, { circleId, answers: {} });
    await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId,
        email: "gone@example.com",
        invitedByUserId: owner._id,
        expiresAt: Date.now() - 1,
      }),
    );

    expect(await t.query(api.activation.getActivationChecklist, {})).toMatchObject({
      sharedMemberState: "not_started",
    });
  });
});

describe("activation member CTA", () => {
  it("prefers the earliest setup-complete owned regular Circle, else incomplete Setup, else create", async () => {
    const t = createTestConvex();
    const { owner } = await t.run((ctx) => seedOnboardedOwner(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    expect(await t.query(api.activation.getActivationChecklist, {})).toMatchObject({
      memberCta: { kind: "create" },
    });

    const incompleteId = await t.mutation(api.circles.createCircle, {
      name: "Alpha",
      currency: "USD",
      color: "blue",
      mark: "A",
    });
    expect(await t.query(api.activation.getActivationChecklist, {})).toMatchObject({
      memberCta: { kind: "setup", circleRef: expect.stringMatching(/^alpha-/) },
    });

    await t.mutation(api.circles.completeCircleSetup, { circleId: incompleteId, answers: {} });
    const laterIncomplete = await t.mutation(api.circles.createCircle, {
      name: "Beta",
      currency: "USD",
      color: "rose",
      mark: "B",
    });
    expect(laterIncomplete).toEqual(expect.any(String));
    const view = await t.query(api.activation.getActivationChecklist, {});
    expect(view.status).toBe("ready");
    if (view.status !== "ready") {
      throw new Error("expected ready");
    }
    expect(view.memberCta.kind).toBe("members");
    if (view.memberCta.kind !== "members") {
      throw new Error("expected members CTA");
    }
    const alpha = await t.run((ctx) => ctx.db.get(incompleteId));
    expect(view.memberCta.circleRef).toBe(buildRef("Alpha", incompleteId));
    expect(alpha?.name).toBe("Alpha");
  });
});

describe("skip and acknowledge", () => {
  it("persists Skip without fabricating completion and is idempotent", async () => {
    const t = createTestConvex();
    const { owner } = await t.run((ctx) => seedOnboardedOwner(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    const first = await t.mutation(api.activation.skipActivationChecklist, {});
    expect(first).toEqual({ completedCount: 0, claimed: true });
    const afterSkip = await t.query(api.activation.getActivationChecklist, {});
    expect(afterSkip).toMatchObject({
      status: "ready",
      dismissed: true,
      visible: false,
      completedCount: 0,
      personalTransactionComplete: false,
    });

    const dismissedAt = await t.run(async (ctx) => {
      const [row] = await activationRows(ctx, owner._id);
      return row?.dismissedAt;
    });
    const second = await t.mutation(api.activation.skipActivationChecklist, {});
    expect(second).toEqual({ completedCount: 0, claimed: false });
    await t.run(async (ctx) => {
      const [row] = await activationRows(ctx, owner._id);
      expect(row?.dismissedAt).toBe(dismissedAt);
    });
  });

  it("claims completion analytics once after all four milestones", async () => {
    const t = createTestConvex();
    const { owner, personalCircleId } = await t.run((ctx) => seedOnboardedOwner(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    expect(await t.mutation(api.activation.acknowledgeActivationCompleted, {})).toEqual({
      claimed: false,
    });

    await t.mutation(api.categories.createCategory, {
      circleId: personalCircleId,
      name: "Rent",
      type: "expense",
      color: "orange",
    });
    const categoryId = await t.run(async (ctx) => {
      const category = await ctx.db
        .query("categories")
        .withIndex("by_circle", (q) => q.eq("circleId", personalCircleId))
        .first();
      if (!category) {
        throw new Error("category missing");
      }
      return category._id;
    });
    await t.mutation(api.transactions.createTransaction, {
      circleId: personalCircleId,
      type: "expense",
      title: "May rent",
      amountMinorUnits: 120_000,
      date: "2026-05-01",
      categoryIds: [categoryId],
    });
    const circleId = await t.mutation(api.circles.createCircle, {
      name: "House",
      currency: "USD",
      color: "blue",
      mark: "H",
    });
    await t.mutation(api.circles.completeCircleSetup, { circleId, answers: {} });
    const invitee = await t.run((ctx) => makeUser(ctx, "roomie@example.com", "Roomie"));
    const token = await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId,
        email: invitee.email,
        invitedByUserId: owner._id,
      }),
    );
    mockCurrentUser.mockResolvedValue(invitee);
    await mutateAndDrain(t, () => t.mutation(api.invitations.acceptInvitation, { token }));
    mockCurrentUser.mockResolvedValue(owner);

    expect(await t.query(api.activation.getActivationChecklist, {})).toMatchObject({
      allComplete: true,
      visible: false,
      completionEventPending: true,
    });

    expect(await t.mutation(api.activation.acknowledgeActivationCompleted, {})).toEqual({
      claimed: true,
    });
    expect(await t.mutation(api.activation.acknowledgeActivationCompleted, {})).toEqual({
      claimed: false,
    });
    expect(await t.query(api.activation.getActivationChecklist, {})).toMatchObject({
      completionEventPending: false,
      allComplete: true,
    });
  });
});

describe("activation monotonicity", () => {
  it("never clears a milestone after archive, delete, remove, leave, or transfer", async () => {
    const t = createTestConvex();
    const { owner, personalCircleId } = await t.run((ctx) => seedOnboardedOwner(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    const categoryId = await t.mutation(api.categories.createCategory, {
      circleId: personalCircleId,
      name: "Temp",
      type: "expense",
      color: "green",
    });
    await t.mutation(api.transactions.createTransaction, {
      circleId: personalCircleId,
      type: "expense",
      title: "Temp spend",
      amountMinorUnits: 100,
      date: "2026-05-02",
      categoryIds: [categoryId],
    });
    await t.mutation(api.categories.archiveCategory, { categoryId });

    const emptyCircleId = await t.mutation(api.circles.createCircle, {
      name: "Gone",
      currency: "USD",
      color: "blue",
      mark: "G",
    });
    await t.mutation(api.circles.deleteCircle, { circleId: emptyCircleId });

    const sharedId = await t.mutation(api.circles.createCircle, {
      name: "Stay",
      currency: "USD",
      color: "blue",
      mark: "S",
    });
    await t.mutation(api.circles.completeCircleSetup, { circleId: sharedId, answers: {} });
    const invitee = await t.run((ctx) => makeUser(ctx, "lea@example.com", "Lea"));
    const token = await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId: sharedId,
        email: invitee.email,
        invitedByUserId: owner._id,
      }),
    );
    mockCurrentUser.mockResolvedValue(invitee);
    await mutateAndDrain(t, () => t.mutation(api.invitations.acceptInvitation, { token }));

    mockCurrentUser.mockResolvedValue(owner);
    const memberId = await t.run(async (ctx) => {
      const member = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", sharedId).eq("userId", invitee._id),
        )
        .unique();
      if (!member) {
        throw new Error("member missing");
      }
      return member._id;
    });
    await mutateAndDrain(t, () =>
      t.mutation(api.members.removeMember, { circleId: sharedId, memberId }),
    );

    expect(await t.query(api.activation.getActivationChecklist, {})).toMatchObject({
      personalCategoryComplete: true,
      personalTransactionComplete: true,
      regularCircleComplete: true,
      sharedMemberState: "complete",
      allComplete: true,
    });

    const second = await t.run((ctx) => makeUser(ctx, "newowner@example.com", "New Owner"));
    const secondMemberId = await t.run(async (ctx) => {
      const added = await addMember(ctx, sharedId, second.email, second.displayName);
      return added.memberId;
    });
    await mutateAndDrain(t, () =>
      t.mutation(api.members.transferOwnership, { circleId: sharedId, toMemberId: secondMemberId }),
    );

    expect(await t.query(api.activation.getActivationChecklist, {})).toMatchObject({
      allComplete: true,
      sharedMemberState: "complete",
      regularCircleComplete: true,
    });
  });
});
