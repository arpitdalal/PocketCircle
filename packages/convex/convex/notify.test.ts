import {
  buildCategoryNotificationLink,
  buildCircleNotificationLink,
  buildRef,
  buildTransactionNotificationLink,
  parseNotificationLinkPath,
} from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainScheduledFunctions, mutateAndDrain } from "../test/mutateAndDrain.js";
import { listNotificationsForUser } from "../test/notifications.js";
import {
  addMember,
  makeUser,
  markCircleSetupComplete,
  seedCircle,
  seedFixture,
  seedInvitation,
  seedTransaction,
} from "../test/seed.js";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { circleSetupFields } from "./circleSetup.js";
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
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

beforeEach(() => {
  mockCurrentUser.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function seedPendingInvitation(
  ctx: MutationCtx,
  opts: {
    circleId: Id<"circles">;
    email: string;
    invitedByUserId: Id<"users">;
    token?: string;
  },
) {
  const token = opts.token ?? generateInvitationToken();
  const tokenHash = await hashInvitationToken(token);
  const now = Date.now();
  await ctx.db.insert("invitations", {
    circleId: opts.circleId,
    emailLower: opts.email.toLowerCase(),
    tokenHash,
    status: "pending",
    invitedByUserId: opts.invitedByUserId,
    resendCount: 0,
    resendTimestamps: [],
    createdAt: now,
    expiresAt: now + INVITE_TTL_MS,
  });
  return token;
}

function baseExpense(categoryIds: Id<"categories">[]) {
  return {
    type: "expense" as const,
    title: "Weekly shop",
    amountMinorUnits: 1250,
    date: "2026-05-15",
    categoryIds,
  };
}

function isValidIdFromCtx(ctx: MutationCtx) {
  return (candidate: string) =>
    ctx.db.normalizeId("circles", candidate) !== null ||
    ctx.db.normalizeId("transactions", candidate) !== null ||
    ctx.db.normalizeId("categories", candidate) !== null;
}

describe("deliverOne", () => {
  it("inserts an unread notification for another User", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await t.run((ctx) => seedCircle(ctx));
    const member = await t.run((ctx) => makeUser(ctx, "m@example.com", "Maya Member"));

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: member._id,
        actorUserId: owner._id,
        type: "member.removed",
        title: "Removed from Circle",
        body: "You were removed from Trip.",
      }),
    );

    const rows = await t.run(async (ctx) => listNotificationsForUser(ctx, member._id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "member.removed",
      title: "Removed from Circle",
      body: "You were removed from Trip.",
      read: false,
    });
  });

  it("no-ops when recipient equals actor", async () => {
    const t = convexTest(schema, modules);
    const { owner } = await t.run((ctx) => seedCircle(ctx));

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: owner._id,
        actorUserId: owner._id,
        type: "circle.archived",
        title: "Circle archived",
      }),
    );

    const rows = await t.run(async (ctx) => listNotificationsForUser(ctx, owner._id));
    expect(rows).toHaveLength(0);
  });
});

describe("scheduler decoupling (ADR 0027)", () => {
  it("commits the business mutation before notifications are delivered", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await ctx.db.patch(seed.circleId, circleSetupFields(Date.now()));
      return seed;
    });
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(owner);

    vi.useFakeTimers();
    try {
      await t.mutation(api.circles.archiveCircle, { circleId });

      await t.run(async (ctx) => {
        const circle = await ctx.db.get(circleId);
        expect(circle?.status).toBe("archived");
        expect(await listNotificationsForUser(ctx, maya.user._id)).toHaveLength(0);
      });

      await drainScheduledFunctions(t);

      await t.run(async (ctx) => {
        expect(await listNotificationsForUser(ctx, maya.user._id)).toHaveLength(1);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not roll back archiveCircle when one recipient delivery fails", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await ctx.db.patch(seed.circleId, circleSetupFields(Date.now()));
      return seed;
    });
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(owner);
    // Force a real delivery failure for Maya: remove her user row so deliverOne
    // fails when the scheduled job runs (recipient gone in the async gap).
    await t.run((ctx) => ctx.db.delete(maya.user._id));

    await mutateAndDrain(t, () => t.mutation(api.circles.archiveCircle, { circleId }));

    await t.run(async (ctx) => {
      expect((await ctx.db.get(circleId))?.status).toBe("archived");
      expect(await listNotificationsForUser(ctx, maya.user._id)).toHaveLength(0);
    });
  });

  it("isolates fan-out failures so other recipients still receive notifications", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await ctx.db.patch(seed.circleId, circleSetupFields(Date.now()));
      return seed;
    });
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    const ada = await t.run((ctx) => addMember(ctx, circleId, "ada@example.com", "Ada Lovelace"));
    // Force a real delivery failure for Maya: remove her user row so deliverOne
    // fails when the scheduled job runs (recipient gone in the async gap).
    await t.run((ctx) => ctx.db.delete(maya.user._id));

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.fanOutCircleLifecycle, {
        circleId,
        actorUserId: owner._id,
        actorDisplayName: "Olive Owner",
        action: "archived",
      }),
    );

    await t.run(async (ctx) => {
      expect(await listNotificationsForUser(ctx, maya.user._id)).toHaveLength(0);
      const adaRows = await listNotificationsForUser(ctx, ada.user._id);
      expect(adaRows).toHaveLength(1);
      expect(adaRows[0]).toMatchObject({
        type: "circle.archived",
        title: "Circle archived",
        body: "Olive Owner archived Trip.",
      });
      expect(await listNotificationsForUser(ctx, owner._id)).toHaveLength(0);
    });
  });

  it("does not schedule delivery jobs for actor-skip recipients at enqueue time", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await ctx.db.patch(seed.circleId, circleSetupFields(Date.now()));
      return seed;
    });
    mockCurrentUser.mockResolvedValue(owner);

    vi.useFakeTimers();
    try {
      await t.mutation(api.circles.archiveCircle, { circleId });
      await drainScheduledFunctions(t);
    } finally {
      vi.useRealTimers();
    }

    await t.run(async (ctx) => {
      expect(await listNotificationsForUser(ctx, owner._id)).toHaveLength(0);
    });
  });
});

describe("notification creation on events (NTF-2)", () => {
  it("acceptInvitation notifies the inviting Owner with a circle link", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const ada = await t.run((ctx) => makeUser(ctx, "ada@example.com", "Ada Lovelace"));
    const token = await t.run((ctx) =>
      seedPendingInvitation(ctx, { circleId, email: ada.email, invitedByUserId: owner._id }),
    );
    mockCurrentUser.mockResolvedValue(ada);

    await mutateAndDrain(t, () => t.mutation(api.invitations.acceptInvitation, { token }));

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(circleId);
      const circleRef = buildRef(circle?.name ?? "Trip", circleId);
      const rows = await listNotificationsForUser(ctx, owner._id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "invitation.accepted",
        title: "Invitation accepted",
        body: "Ada Lovelace joined Trip.",
        link: buildCircleNotificationLink(circleRef),
        read: false,
      });
      expect(parseNotificationLinkPath(rows[0]?.link ?? "", isValidIdFromCtx(ctx))?.kind).toBe(
        "circle",
      );
      expect(await listNotificationsForUser(ctx, ada._id)).toHaveLength(0);
    });
  });

  it("revokeInvitation notifies an existing account and skips unknown emails", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const ada = await t.run((ctx) => makeUser(ctx, "ada@example.com", "Ada Lovelace"));
    mockCurrentUser.mockResolvedValue(owner);

    const knownInviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, { email: ada.email }),
    );
    const unknownInviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, { email: "ghost@example.com" }),
    );

    await mutateAndDrain(t, async () => {
      await t.mutation(api.invitations.revokeInvitation, { invitationId: knownInviteId });
      await t.mutation(api.invitations.revokeInvitation, { invitationId: unknownInviteId });
    });

    await t.run(async (ctx) => {
      const adaRows = await listNotificationsForUser(ctx, ada._id);
      expect(adaRows).toHaveLength(1);
      expect(adaRows[0]).toMatchObject({
        type: "invitation.revoked",
        title: "Invitation revoked",
        body: "Your invitation to Trip was revoked.",
        read: false,
      });
      expect(adaRows[0]?.link).toBeUndefined();
      expect(await listNotificationsForUser(ctx, owner._id)).toHaveLength(0);
    });
  });

  it("removeMember notifies the removed Member with a circle link", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(owner);

    await mutateAndDrain(t, () =>
      t.mutation(api.members.removeMember, { circleId, memberId: maya.memberId }),
    );

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(circleId);
      const circleRef = buildRef(circle?.name ?? "Trip", circleId);
      const rows = await listNotificationsForUser(ctx, maya.user._id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "member.removed",
        title: "Removed from Circle",
        body: "You were removed from Trip.",
        link: buildCircleNotificationLink(circleRef),
      });
    });
  });

  it("transferOwnership notifies the new Owner", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(owner);

    await mutateAndDrain(t, () =>
      t.mutation(api.members.transferOwnership, { circleId, toMemberId: maya.memberId }),
    );

    await t.run(async (ctx) => {
      const rows = await listNotificationsForUser(ctx, maya.user._id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe("ownership.transferred");
      expect(rows[0]?.title).toBe("Ownership transferred");
      expect(rows[0]?.body).toBe("You are now the Owner of Trip.");
      expect(await listNotificationsForUser(ctx, owner._id)).toHaveLength(0);
    });
  });

  it("archiveCircle and restoreCircle fan out to other active Members only", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await ctx.db.patch(seed.circleId, circleSetupFields(Date.now()));
      return seed;
    });
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(owner);

    await mutateAndDrain(t, () => t.mutation(api.circles.archiveCircle, { circleId }));

    await t.run(async (ctx) => {
      expect(await listNotificationsForUser(ctx, owner._id)).toHaveLength(0);
      const mayaRows = await listNotificationsForUser(ctx, maya.user._id);
      expect(mayaRows).toHaveLength(1);
      expect(mayaRows[0]).toMatchObject({
        type: "circle.archived",
        title: "Circle archived",
        body: "Olive Owner archived Trip.",
      });
    });

    await mutateAndDrain(t, () => t.mutation(api.circles.restoreCircle, { circleId }));

    await t.run(async (ctx) => {
      const mayaRows = await listNotificationsForUser(ctx, maya.user._id);
      expect(mayaRows.filter((row) => row.type === "circle.restored")).toHaveLength(1);
      expect(mayaRows.find((row) => row.type === "circle.restored")?.body).toBe(
        "Olive Owner restored Trip.",
      );
    });
  });

  it("archiveCircle on a solo Circle still schedules fan-out but emits zero notifications", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await ctx.db.patch(seed.circleId, circleSetupFields(Date.now()));
      return seed;
    });
    mockCurrentUser.mockResolvedValue(owner);

    vi.useFakeTimers();
    try {
      await t.mutation(api.circles.archiveCircle, { circleId });

      await t.run(async (ctx) => {
        const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
        // Fan-out always schedules; actor exclusion still yields no deliveries.
        expect(scheduled.length).toBeGreaterThan(0);
        expect(await listNotificationsForUser(ctx, owner._id)).toHaveLength(0);
      });

      await drainScheduledFunctions(t);

      await t.run(async (ctx) => {
        expect(await listNotificationsForUser(ctx, owner._id)).toHaveLength(0);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("createTransaction notifies Paid By when set to another Member", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const maya = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(f.owner);

    const id = await mutateAndDrain(t, () =>
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId]),
        paidByMemberId: maya.memberId,
      }),
    );

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(f.circleId);
      const txn = await ctx.db.get(id);
      const circleRef = buildRef(circle?.name ?? "Trip", f.circleId);
      const txnRef = buildRef(txn?.title ?? "Weekly shop", id);
      const rows = await listNotificationsForUser(ctx, maya.user._id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "transaction.paid_by",
        title: "Paid By updated",
        body: "Olive Owner set you as Paid By on Weekly shop.",
        link: buildTransactionNotificationLink(circleRef, txnRef),
      });
      expect(parseNotificationLinkPath(rows[0]?.link ?? "", isValidIdFromCtx(ctx))?.kind).toBe(
        "transaction",
      );
      expect(await listNotificationsForUser(ctx, f.owner._id)).toHaveLength(0);
    });
  });

  it("createTransaction skips notification when Paid By is self", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    await mutateAndDrain(t, () =>
      t.mutation(api.transactions.createTransaction, {
        circleId: f.circleId,
        ...baseExpense([f.groceriesId]),
      }),
    );

    await t.run(async (ctx) => {
      expect(await listNotificationsForUser(ctx, f.owner._id)).toHaveLength(0);
    });
  });

  it("archiveTransaction notifies the recorder when moderated by the Owner", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const maya = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { recordedByMemberId: maya.memberId }));
    mockCurrentUser.mockResolvedValue(f.owner);

    await mutateAndDrain(t, () =>
      t.mutation(api.transactions.archiveTransaction, { transactionId: id }),
    );

    await t.run(async (ctx) => {
      const rows = await listNotificationsForUser(ctx, maya.user._id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "transaction.archived",
        title: "Transaction archived",
        body: "Olive Owner archived Weekly shop.",
      });
      expect(await listNotificationsForUser(ctx, f.owner._id)).toHaveLength(0);
    });
  });

  it("archiveTransaction skips notification when the recorder archives their own Transaction", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const maya = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    const id = await t.run((ctx) => seedTransaction(ctx, f, { recordedByMemberId: maya.memberId }));
    mockCurrentUser.mockResolvedValue(maya.user);

    await mutateAndDrain(t, () =>
      t.mutation(api.transactions.archiveTransaction, { transactionId: id }),
    );

    await t.run(async (ctx) => {
      expect(await listNotificationsForUser(ctx, maya.user._id)).toHaveLength(0);
    });
  });

  it("restoreTransaction notifies the recorder when moderated by the Owner", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const maya = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    const id = await t.run((ctx) =>
      seedTransaction(ctx, f, { recordedByMemberId: maya.memberId, status: "archived" }),
    );
    mockCurrentUser.mockResolvedValue(f.owner);

    await mutateAndDrain(t, () =>
      t.mutation(api.transactions.restoreTransaction, { transactionId: id }),
    );

    await t.run(async (ctx) => {
      const rows = await listNotificationsForUser(ctx, maya.user._id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe("transaction.restored");
      expect(rows[0]?.body).toBe("Olive Owner restored Weekly shop.");
    });
  });

  it("archiveCategory notifies the creator when moderated by the Owner", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const maya = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    const categoryId = await t.run((ctx) =>
      ctx.db.insert("categories", {
        circleId: f.circleId,
        name: "Coffee",
        nameLower: "coffee",
        type: "expense",
        color: "brown",
        creatorUserId: maya.user._id,
        status: "active",
        createdAt: Date.now(),
      }),
    );
    mockCurrentUser.mockResolvedValue(f.owner);

    await mutateAndDrain(t, () => t.mutation(api.categories.archiveCategory, { categoryId }));

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(f.circleId);
      const category = await ctx.db.get(categoryId);
      const circleRef = buildRef(circle?.name ?? "Trip", f.circleId);
      const categoryRef = buildRef(category?.name ?? "Coffee", categoryId);
      const rows = await listNotificationsForUser(ctx, maya.user._id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "category.archived",
        title: "Category archived",
        body: "Olive Owner archived Coffee.",
        link: buildCategoryNotificationLink(circleRef, categoryRef),
      });
      expect(parseNotificationLinkPath(rows[0]?.link ?? "", isValidIdFromCtx(ctx))?.kind).toBe(
        "category",
      );
    });
  });

  it("archiveCategory skips notification when the creator archives their own Category", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    await mutateAndDrain(t, () =>
      t.mutation(api.categories.archiveCategory, { categoryId: f.groceriesId }),
    );

    await t.run(async (ctx) => {
      expect(await listNotificationsForUser(ctx, f.owner._id)).toHaveLength(0);
    });
  });

  it("restoreCategory notifies the creator when moderated by the Owner", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const maya = await t.run((ctx) => addMember(ctx, f.circleId, "m@example.com", "Maya Member"));
    const categoryId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("categories", {
        circleId: f.circleId,
        name: "Coffee",
        nameLower: "coffee",
        type: "expense",
        color: "brown",
        creatorUserId: maya.user._id,
        status: "archived",
        archivedAt: Date.now(),
        createdAt: Date.now(),
      });
      return id;
    });
    mockCurrentUser.mockResolvedValue(f.owner);

    await mutateAndDrain(t, () => t.mutation(api.categories.restoreCategory, { categoryId }));

    await t.run(async (ctx) => {
      const rows = await listNotificationsForUser(ctx, maya.user._id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe("category.restored");
      expect(rows[0]?.body).toBe("Olive Owner restored Coffee.");
    });
  });

  it("stored links round-trip through parseNotificationLinkPath", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const txnId = await t.run((ctx) => seedTransaction(ctx, f));

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(f.circleId);
      const txn = await ctx.db.get(txnId);
      const category = await ctx.db.get(f.groceriesId);
      if (!circle || !txn || !category) {
        throw new Error("seed missing");
      }
      const circleRef = buildRef(circle.name, circle._id);
      const txnRef = buildRef(txn.title, txn._id);
      const categoryRef = buildRef(category.name, category._id);

      const isValidId = isValidIdFromCtx(ctx);
      const circleLink = buildCircleNotificationLink(circleRef);
      const txnLink = buildTransactionNotificationLink(circleRef, txnRef);
      const categoryLink = buildCategoryNotificationLink(circleRef, categoryRef);

      expect(parseNotificationLinkPath(circleLink, isValidId)?.kind).toBe("circle");
      expect(parseNotificationLinkPath(txnLink, isValidId)?.kind).toBe("transaction");
      expect(parseNotificationLinkPath(categoryLink, isValidId)?.kind).toBe("category");
    });
  });
});
