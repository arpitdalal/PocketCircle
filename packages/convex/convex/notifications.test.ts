import { buildCategoryNotificationLink, buildRef } from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainScheduledFunctions, mutateAndDrain } from "../test/mutateAndDrain.js";
import { addMember, firstPage, seedFixture, seedTransaction } from "../test/seed.js";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import * as guard from "./guard.js";
import { MARK_ALL_READ_CHUNK_SIZE, NOTIFICATION_BATCH_SIZE } from "./notifications.js";
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

beforeEach(() => {
  mockCurrentUser.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function listArgs(unreadOnly: boolean, size = NOTIFICATION_BATCH_SIZE) {
  return { unreadOnly, ...firstPage(size) };
}

type TestDbCtx = Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0];

async function insertNotification(
  ctx: TestDbCtx,
  opts: {
    userId: Id<"users">;
    type?: string;
    title: string;
    body?: string;
    link?: string;
    read?: boolean;
    createdAt?: number;
  },
) {
  return await ctx.db.insert("notifications", {
    userId: opts.userId,
    type: opts.type ?? "test",
    title: opts.title,
    body: opts.body,
    link: opts.link,
    read: opts.read ?? false,
    createdAt: opts.createdAt ?? Date.now(),
  });
}

async function insertUnreadBatch(
  ctx: TestDbCtx,
  userId: Id<"users">,
  count: number,
  titlePrefix: string,
) {
  for (let i = 0; i < count; i++) {
    await insertNotification(ctx, {
      userId,
      title: `${titlePrefix} ${i}`,
      createdAt: i,
    });
  }
}

describe("notifications", () => {
  it("lists unread notifications for the current User newest-first", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const { user: member } = await t.run((ctx) =>
      addMember(ctx, f.circleId, "member@example.com", "Member"),
    );
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.run(async (ctx) => {
      await insertNotification(ctx, {
        userId: f.owner._id,
        title: "Older unread",
        createdAt: 1000,
      });
      await insertNotification(ctx, {
        userId: f.owner._id,
        title: "Newer unread",
        createdAt: 2000,
      });
      await insertNotification(ctx, {
        userId: f.owner._id,
        title: "Already read",
        read: true,
        createdAt: 3000,
      });
      await insertNotification(ctx, {
        userId: member._id,
        title: "Someone else",
        createdAt: 4000,
      });
    });

    const unread = await t.query(api.notifications.listNotifications, listArgs(true));
    expect(unread.page.map((n) => n.title)).toEqual(["Newer unread", "Older unread"]);
    expect(unread.page.every((n) => n.read === false)).toBe(true);

    const all = await t.query(api.notifications.listNotifications, listArgs(false));
    expect(all.page.map((n) => n.title)).toEqual(["Already read", "Newer unread", "Older unread"]);
  });

  it("lists All by _creationTime newest-first, not createdAt", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.run(async (ctx) => {
      await insertNotification(ctx, {
        userId: f.owner._id,
        title: "Inserted first",
        createdAt: 9000,
      });
      await insertNotification(ctx, {
        userId: f.owner._id,
        title: "Inserted second (read)",
        read: true,
        createdAt: 5000,
      });
      await insertNotification(ctx, {
        userId: f.owner._id,
        title: "Inserted third",
        createdAt: 1000,
      });
    });

    const all = await t.query(api.notifications.listNotifications, listArgs(false));
    expect(all.page.map((n) => n.title)).toEqual([
      "Inserted third",
      "Inserted second (read)",
      "Inserted first",
    ]);
  });

  it("paginates Unread and All at the list page size", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await insertNotification(ctx, {
          userId: f.owner._id,
          title: `Unread ${i}`,
          createdAt: i,
        });
      }
      await insertNotification(ctx, {
        userId: f.owner._id,
        title: "Read row",
        read: true,
        createdAt: 99,
      });
    });

    const unread = await t.query(api.notifications.listNotifications, listArgs(true, 2));
    expect(unread.page.map((n) => n.title)).toEqual(["Unread 2", "Unread 1"]);
    expect(unread.isDone).toBe(false);

    const all = await t.query(api.notifications.listNotifications, listArgs(false, 2));
    expect(all.page.map((n) => n.title)).toEqual(["Read row", "Unread 2"]);
    expect(all.isDone).toBe(false);
  });

  it("marks one notification read and updates the unread count", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    const notificationId = await t.run(async (ctx) =>
      insertNotification(ctx, { userId: f.owner._id, title: "Ping" }),
    );

    expect(await t.query(api.notifications.getUnreadCount, {})).toEqual({
      count: 1,
      hasMore: false,
    });

    await t.mutation(api.notifications.markNotificationRead, { notificationId });

    const row = await t.run(async (ctx) => ctx.db.get(notificationId));
    expect(row?.read).toBe(true);
    expect(await t.query(api.notifications.getUnreadCount, {})).toEqual({
      count: 0,
      hasMore: false,
    });
  });

  it("markNotificationRead is a no-op when already read", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    const notificationId = await t.run(async (ctx) =>
      insertNotification(ctx, { userId: f.owner._id, title: "Done", read: true }),
    );

    await t.mutation(api.notifications.markNotificationRead, { notificationId });
    expect(await t.query(api.notifications.getUnreadCount, {})).toEqual({
      count: 0,
      hasMore: false,
    });
  });

  it("markAllRead marks every unread for the current User", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.run(async (ctx) => {
      await insertNotification(ctx, { userId: f.owner._id, title: "One" });
      await insertNotification(ctx, { userId: f.owner._id, title: "Two", read: true });
      await insertNotification(ctx, { userId: f.owner._id, title: "Three" });
    });

    await t.mutation(api.notifications.markAllRead, {});

    expect(await t.query(api.notifications.getUnreadCount, {})).toEqual({
      count: 0,
      hasMore: false,
    });
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("notifications")
        .withIndex("by_user", (q) => q.eq("userId", f.owner._id))
        .collect();
      expect(rows.filter((row) => !row.read).map((row) => row.title)).toEqual([]);
      expect(rows.find((row) => row.title === "Two")?.read).toBe(true);
    });
  });

  it("markAllRead drains unread beyond one chunk via the scheduler", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    const totalUnread = MARK_ALL_READ_CHUNK_SIZE + 5;
    await t.run(async (ctx) => {
      await insertUnreadBatch(ctx, f.owner._id, totalUnread, "Unread");
    });

    await mutateAndDrain(t, () => t.mutation(api.notifications.markAllRead, {}));

    expect(await t.query(api.notifications.getUnreadCount, {})).toEqual({
      count: 0,
      hasMore: false,
    });
    const leftover = await t.query(api.notifications.listNotifications, listArgs(true));
    expect(leftover.page).toEqual([]);
  });

  it("markAllRead does not mark unread inserted after the click-time watermark", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const { user: member } = await t.run((ctx) =>
      addMember(ctx, f.circleId, "member@example.com", "Member"),
    );
    mockCurrentUser.mockResolvedValue(f.owner);

    const totalUnread = MARK_ALL_READ_CHUNK_SIZE + 5;
    await t.run(async (ctx) => {
      await insertUnreadBatch(ctx, f.owner._id, totalUnread, "Pre-click");
      await insertNotification(ctx, {
        userId: member._id,
        title: "Other user unread",
        createdAt: 50_000,
      });
    });

    await t.mutation(api.notifications.markAllRead, {});

    const postClickId = await t.run(async (ctx) =>
      insertNotification(ctx, {
        userId: f.owner._id,
        title: "Post-click",
        createdAt: 99_000,
      }),
    );

    await drainScheduledFunctions(t);

    expect(await t.query(api.notifications.getUnreadCount, {})).toEqual({
      count: 1,
      hasMore: false,
    });
    const leftover = await t.query(api.notifications.listNotifications, listArgs(true));
    expect(leftover.page.map((n) => n.title)).toEqual(["Post-click"]);
    await t.run(async (ctx) => {
      const postClick = await ctx.db.get(postClickId);
      expect(postClick?.read).toBe(false);
      const other = await ctx.db
        .query("notifications")
        .withIndex("by_user", (q) => q.eq("userId", member._id))
        .collect();
      expect(other).toEqual([expect.objectContaining({ title: "Other user unread", read: false })]);
    });
  });

  it("rejects marking another User's notification", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const { user: member } = await t.run((ctx) =>
      addMember(ctx, f.circleId, "member@example.com", "Member"),
    );
    mockCurrentUser.mockResolvedValue(f.owner);

    const notificationId = await t.run(async (ctx) =>
      insertNotification(ctx, { userId: member._id, title: "Private" }),
    );

    await expect(
      t.mutation(api.notifications.markNotificationRead, { notificationId }),
    ).rejects.toThrow("Notification not found");
  });

  it("memoizes circle access across a notification batch", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    const circle = await t.run(async (ctx) => ctx.db.get(f.circleId));
    const circleRef = buildRef(circle?.name ?? "Trip", f.circleId);

    await t.run(async (ctx) => {
      for (let i = 0; i < NOTIFICATION_BATCH_SIZE; i++) {
        await insertNotification(ctx, {
          userId: f.owner._id,
          title: `Ping ${i}`,
          link: `/circles/${circleRef}`,
          createdAt: i,
        });
      }
    });

    const accessSpy = vi.spyOn(guard, "resolveCircleAccessForUser");
    await t.query(api.notifications.listNotifications, listArgs(true));
    expect(accessSpy).toHaveBeenCalledTimes(1);
    accessSpy.mockRestore();
  });

  it("caps unread count at 99 with hasMore", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.run(async (ctx) => {
      for (let i = 0; i < 100; i++) {
        await insertNotification(ctx, {
          userId: f.owner._id,
          title: `Unread ${i}`,
          createdAt: i,
        });
      }
    });

    expect(await t.query(api.notifications.getUnreadCount, {})).toEqual({
      count: 99,
      hasMore: true,
    });
  });
});

describe("notification link resolution", () => {
  it("keeps accessible circle, transaction, and category links", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    const circle = await t.run(async (ctx) => ctx.db.get(f.circleId));
    const circleRef = buildRef(circle?.name ?? "Trip", f.circleId);
    const txnId = await t.run((ctx) => seedTransaction(ctx, f));
    const txn = await t.run(async (ctx) => ctx.db.get(txnId));
    const txnRef = buildRef(txn?.title ?? "Weekly shop", txnId);
    const category = await t.run(async (ctx) => ctx.db.get(f.groceriesId));
    const categoryRef = buildRef(category?.name ?? "Groceries", f.groceriesId);

    await t.run(async (ctx) => {
      await insertNotification(ctx, {
        userId: f.owner._id,
        title: "Circle",
        link: `/circles/${circleRef}`,
      });
      await insertNotification(ctx, {
        userId: f.owner._id,
        title: "Transaction",
        link: `/circles/${circleRef}/transactions/${txnRef}`,
      });
      await insertNotification(ctx, {
        userId: f.owner._id,
        title: "Category",
        link: buildCategoryNotificationLink(circleRef, categoryRef),
      });
    });

    const { page } = await t.query(api.notifications.listNotifications, listArgs(true));
    const byTitle = Object.fromEntries(page.map((n) => [n.title, n.link]));
    expect(byTitle.Circle).toBe(`/circles/${circleRef}`);
    expect(byTitle.Transaction).toBe(`/circles/${circleRef}/transactions/${txnRef}`);
    expect(byTitle.Category).toBe(buildCategoryNotificationLink(circleRef, categoryRef));
  });

  it("drops links after the User loses Circle access", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const { user: member, memberId } = await t.run((ctx) =>
      addMember(ctx, f.circleId, "member@example.com", "Member"),
    );
    mockCurrentUser.mockResolvedValue(member);

    const circle = await t.run(async (ctx) => ctx.db.get(f.circleId));
    const circleRef = buildRef(circle?.name ?? "Trip", f.circleId);
    const notificationId = await t.run(async (ctx) =>
      insertNotification(ctx, {
        userId: member._id,
        title: "Invite",
        link: `/circles/${circleRef}`,
      }),
    );

    let { page } = await t.query(api.notifications.listNotifications, listArgs(true));
    expect(page[0]?.link).toBe(`/circles/${circleRef}`);

    await t.run(async (ctx) => {
      await ctx.db.patch(memberId, { status: "removed", removedAt: Date.now() });
    });

    ({ page } = await t.query(api.notifications.listNotifications, listArgs(true)));
    expect(page[0]?.link).toBeUndefined();

    await t.run(async (ctx) => {
      await ctx.db.patch(notificationId, { read: true });
    });
  });

  it("keeps links for archived-but-accessible Circles and objects", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run(async (ctx) => seedFixture(ctx, { archived: true }));
    mockCurrentUser.mockResolvedValue(f.owner);

    const circle = await t.run(async (ctx) => ctx.db.get(f.circleId));
    const circleRef = buildRef(circle?.name ?? "Trip", f.circleId);
    const txnId = await t.run(async (ctx) => seedTransaction(ctx, f, { status: "archived" }));
    const txn = await t.run(async (ctx) => ctx.db.get(txnId));
    const txnRef = buildRef(txn?.title ?? "Weekly shop", txnId);

    await t.run(async (ctx) => {
      await insertNotification(ctx, {
        userId: f.owner._id,
        title: "Archived txn",
        link: `/circles/${circleRef}/transactions/${txnRef}`,
      });
    });

    const { page } = await t.query(api.notifications.listNotifications, listArgs(true));
    expect(page[0]?.link).toBe(`/circles/${circleRef}/transactions/${txnRef}`);
  });

  it("drops links when the object belongs to a different Circle than the URL", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    const other = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    const otherCircle = await t.run(async (ctx) => ctx.db.get(other.circleId));
    const otherCircleRef = buildRef(otherCircle?.name ?? "Trip", other.circleId);
    const txnId = await t.run(async (ctx) => seedTransaction(ctx, f));
    const txn = await t.run(async (ctx) => ctx.db.get(txnId));
    const txnRef = buildRef(txn?.title ?? "Weekly shop", txnId);

    await t.run(async (ctx) => {
      await insertNotification(ctx, {
        userId: f.owner._id,
        title: "Tampered",
        link: `/circles/${otherCircleRef}/transactions/${txnRef}`,
      });
    });

    const { page } = await t.query(api.notifications.listNotifications, listArgs(true));
    expect(page[0]?.link).toBeUndefined();
  });

  it("drops malformed links to text-only", async () => {
    const t = convexTest(schema, modules);
    const f = await t.run((ctx) => seedFixture(ctx));
    mockCurrentUser.mockResolvedValue(f.owner);

    await t.run(async (ctx) => {
      await insertNotification(ctx, {
        userId: f.owner._id,
        title: "Bad link",
        link: "/settings",
      });
      await insertNotification(ctx, {
        userId: f.owner._id,
        title: "No link",
      });
    });

    const { page } = await t.query(api.notifications.listNotifications, listArgs(true));
    const byTitle = Object.fromEntries(page.map((n) => [n.title, n.link]));
    expect(byTitle["Bad link"]).toBeUndefined();
    expect(byTitle["No link"]).toBeUndefined();
  });
});
