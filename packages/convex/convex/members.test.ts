import { MUTATION_ERRORS, mutationErrorData } from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mutateAndDrain } from "../test/mutateAndDrain.js";
import { listNotificationsForUser } from "../test/notifications.js";
import { addMember, makeUser, markCircleSetupComplete, seedCircle } from "../test/seed.js";
import { api } from "./_generated/api.js";
import { resolveCircleAccess } from "./guard.js";
import { circleEntity, listEntityHistory } from "./history.js";
import { setUserDisplayName } from "./model.js";
import schema from "./schema.js";

// listMembers resolves access through guard.ts, which folds in
// `getCurrentUserOrNull` — backed by Better Auth and unrunnable under
// convex-test. We stub just that seam (as guard.test.ts does).
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

/** Regular Circle ready for gated Member writes (setup complete). */
async function seedCompletedCircle(
  ctx: Parameters<typeof seedCircle>[0],
  opts: Parameters<typeof seedCircle>[1] = {},
) {
  return await seedCircle(ctx, { ...opts, setupCompletedAt: Date.now() });
}

describe("listMembers — access", () => {
  it("allows an active Member", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);
    const members = await t.query(api.members.listMembers, { circleId });
    expect(members?.length).toBe(1);
  });

  it("returns null for a non-member (anti-enumeration)", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const stranger = await t.run((ctx) => makeUser(ctx, "s@example.com", "Sam Stranger"));
    mockCurrentUser.mockResolvedValue(stranger);
    expect(await t.query(api.members.listMembers, { circleId })).toBeNull();
  });

  it("returns null for an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(null);
    expect(await t.query(api.members.listMembers, { circleId })).toBeNull();
  });
});

describe("listMembers — content", () => {
  it("lists active Members Owner-first with materialized identity and no userId", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(owner);

    const members = await t.query(api.members.listMembers, { circleId });
    expect(members?.map((m) => m.displayName)).toEqual(["Olive Owner", "Maya Member"]);
    expect(members?.[0]?.role).toBe("owner");
    // The caller (the owner here) is flagged self; the other Member is not.
    expect(members?.[0]?.isSelf).toBe(true);
    expect(members?.[1]?.isSelf).toBe(false);
    // No raw userId surfaces to the client.
    for (const member of members ?? []) {
      expect(member).not.toHaveProperty("userId");
    }
  });

  it("flags isSelf relative to the calling Member, not the Owner", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(maya.user); // Maya is the caller, not the owner

    const members = await t.query(api.members.listMembers, { circleId });
    expect(members?.find((m) => m.displayName === "Maya Member")?.isSelf).toBe(true);
    expect(members?.find((m) => m.displayName === "Olive Owner")?.isSelf).toBe(false);
  });

  it("excludes Removed Members by default and includes them with the frozen name when asked", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => addMember(ctx, circleId, "r@example.com", "Rex Removed", "removed"));
    mockCurrentUser.mockResolvedValue(owner);

    const active = await t.query(api.members.listMembers, { circleId });
    expect(active?.map((m) => m.displayName)).toEqual(["Olive Owner"]);

    const all = await t.query(api.members.listMembers, { circleId, includeHistorical: true });
    expect(all?.map((m) => m.displayName)).toContain("Rex Removed");
  });

  it("returns exactly one Member for a Personal Circle", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx, { kind: "personal" }));
    mockCurrentUser.mockResolvedValue(owner);
    expect((await t.query(api.members.listMembers, { circleId }))?.length).toBe(1);
  });
});

describe("transferOwnership — happy path and invariant", () => {
  it("atomically moves ownership on member rows and circles.ownerUserId", async () => {
    const t = convexTest(schema, modules);
    const { owner, ownerMemberId, circleId } = await t.run((ctx) => seedCircle(ctx));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(owner);

    await mutateAndDrain(t, () =>
      t.mutation(api.members.transferOwnership, {
        circleId,
        toMemberId: maya.memberId,
      }),
    );

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(circleId);
      const ownerRow = await ctx.db.get(ownerMemberId);
      const targetRow = await ctx.db.get(maya.memberId);
      expect(targetRow?.role).toBe("owner");
      expect(ownerRow?.role).toBe("member");
      expect(circle?.ownerUserId).toBe(maya.user._id);

      const members = await ctx.db
        .query("members")
        .withIndex("by_circle", (q) => q.eq("circleId", circleId))
        .collect();
      const owners = members.filter((member) => member.role === "owner");
      expect(owners).toHaveLength(1);
      expect(owners[0]?.userId).toBe(circle?.ownerUserId);

      const notifications = await listNotificationsForUser(ctx, maya.user._id);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.type).toBe("ownership.transferred");
    });
  });

  it("records ownership transferred history with display names only", async () => {
    const t = convexTest(schema, modules);
    const { owner, ownerMemberId, circleId } = await t.run((ctx) => seedCircle(ctx));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.members.transferOwnership, {
      circleId,
      toMemberId: maya.memberId,
    });

    await t.run(async (ctx) => {
      const events = await listEntityHistory(ctx, circleEntity(circleId));
      expect(events).toHaveLength(1);
      expect(events[0]?.action).toBe("ownership transferred");
      expect(events[0]?.actorMemberId).toBe(ownerMemberId);
      expect(events[0]?.changes).toEqual([
        { field: "owner", from: "Olive Owner", to: "Maya Member" },
      ]);
    });
  });

  it("reorders listMembers with the new owner first and demotes the old owner", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.members.transferOwnership, {
      circleId,
      toMemberId: maya.memberId,
    });

    mockCurrentUser.mockResolvedValue(maya.user);
    const members = await t.query(api.members.listMembers, { circleId });
    expect(members?.map((m) => m.displayName)).toEqual(["Maya Member", "Olive Owner"]);
    expect(members?.[0]?.role).toBe("owner");
  });
});

describe("transferOwnership — permissions", () => {
  it("rejects a non-owner Member with transfer.forbidden", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    const other = await t.run((ctx) => addMember(ctx, circleId, "o@example.com", "Other Member"));
    mockCurrentUser.mockResolvedValue(maya.user);

    await expect(
      t.mutation(api.members.transferOwnership, { circleId, toMemberId: other.memberId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.transferForbidden),
    });
  });

  it("rejects a Removed Member with Circle not found", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const removed = await t.run((ctx) =>
      addMember(ctx, circleId, "r@example.com", "Rex Removed", "removed"),
    );
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(removed.user);

    await expect(
      t.mutation(api.members.transferOwnership, { circleId, toMemberId: maya.memberId }),
    ).rejects.toThrow(/circle\.unavailable/);
  });

  it("rejects an unauthenticated caller with Circle not found", async () => {
    const t = convexTest(schema, modules);
    const { circleId, ownerMemberId } = await t.run((ctx) => seedCircle(ctx));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(null);

    await expect(
      t.mutation(api.members.transferOwnership, { circleId, toMemberId: maya.memberId }),
    ).rejects.toThrow(/circle\.unavailable/);

    await t.run(async (ctx) => {
      const ownerRow = await ctx.db.get(ownerMemberId);
      expect(ownerRow?.role).toBe("owner");
    });
  });

  it("rejects a non-member with Circle not found", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    const stranger = await t.run((ctx) => makeUser(ctx, "s@example.com", "Sam Stranger"));
    mockCurrentUser.mockResolvedValue(stranger);

    await expect(
      t.mutation(api.members.transferOwnership, { circleId, toMemberId: maya.memberId }),
    ).rejects.toThrow(/circle\.unavailable/);
  });
});

describe("transferOwnership — target validation", () => {
  it("rejects a memberId from a different Circle with Member not found", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    const otherCircle = await t.run((ctx) => seedCircle(ctx));
    const outsider = await t.run((ctx) =>
      addMember(ctx, otherCircle.circleId, "o@example.com", "Other Member"),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.members.transferOwnership, { circleId, toMemberId: outsider.memberId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.memberNotFound),
    });
  });

  it("rejects a missing memberId with Member not found", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    const ghost = await t.run(async (ctx) => {
      const maya = await addMember(ctx, circleId, "m@example.com", "Maya Member");
      await ctx.db.delete(maya.memberId);
      return maya.memberId;
    });
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.members.transferOwnership, { circleId, toMemberId: ghost }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.memberNotFound),
    });
  });

  it("rejects a removed target in this Circle with transfer.targetNotMember", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    const removed = await t.run((ctx) =>
      addMember(ctx, circleId, "r@example.com", "Rex Removed", "removed"),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.members.transferOwnership, { circleId, toMemberId: removed.memberId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.transferTargetNotMember),
    });
  });

  it("rejects self-transfer with transfer.toSelf", async () => {
    const t = convexTest(schema, modules);
    const { owner, ownerMemberId, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.members.transferOwnership, { circleId, toMemberId: ownerMemberId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.transferToSelf),
    });
  });
});

describe("transferOwnership — lifecycle", () => {
  it("allows transfer on an archived Circle (USR-3)", async () => {
    const t = convexTest(schema, modules);
    const { owner, ownerMemberId, circleId } = await t.run((ctx) =>
      seedCircle(ctx, { archived: true }),
    );
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.members.transferOwnership, { circleId, toMemberId: maya.memberId });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(circleId))?.ownerUserId).toBe(maya.user._id);
      expect((await ctx.db.get(maya.memberId))?.role).toBe("owner");
      expect((await ctx.db.get(ownerMemberId))?.role).toBe("member");
    });
  });

  it("allows transfer on an incomplete regular Circle with an active co-Member (ADR 0029)", async () => {
    const t = convexTest(schema, modules);
    const { owner, ownerMemberId, circleId } = await t.run((ctx) => seedCircle(ctx));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.members.transferOwnership, { circleId, toMemberId: maya.memberId });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(circleId))?.setupCompletedAt).toBeNull();
      expect((await ctx.db.get(circleId))?.ownerUserId).toBe(maya.user._id);
      expect((await ctx.db.get(maya.memberId))?.role).toBe("owner");
      expect((await ctx.db.get(ownerMemberId))?.role).toBe("member");
    });
  });

  it("rejects a Personal Circle with transfer.personalCircle", async () => {
    const t = convexTest(schema, modules);
    const { owner, ownerMemberId, circleId } = await t.run((ctx) =>
      seedCircle(ctx, { kind: "personal" }),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.members.transferOwnership, { circleId, toMemberId: ownerMemberId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.transferPersonalCircle),
    });
  });
});

describe("transferOwnership — cross-slice", () => {
  it("lets the new owner rename and blocks the old owner", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCompletedCircle(ctx));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.members.transferOwnership, {
      circleId,
      toMemberId: maya.memberId,
    });

    mockCurrentUser.mockResolvedValue(maya.user);
    await t.mutation(api.circles.renameCircle, { circleId, name: "Renamed Trip" });

    mockCurrentUser.mockResolvedValue(owner);
    await expect(
      t.mutation(api.circles.renameCircle, { circleId, name: "Blocked" }),
    ).rejects.toThrow("Only the owner can rename this circle");
  });
});

describe("removeMember — permissions", () => {
  it("allows the Owner to remove an active non-owner Member", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCompletedCircle(ctx));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(owner);

    await mutateAndDrain(t, () =>
      t.mutation(api.members.removeMember, { circleId, memberId: maya.memberId }),
    );

    await t.run(async (ctx) => {
      const row = await ctx.db.get(maya.memberId);
      expect(row?.status).toBe("removed");
      expect(row?.removedAt).toBeTypeOf("number");
      expect(row?.displayName).toBe("Maya Member");
      expect(row?.image).toBeUndefined();

      const notifications = await listNotificationsForUser(ctx, maya.user._id);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.type).toBe("member.removed");
    });
  });

  it("rejects a non-owner Member with member.removeForbidden", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    const other = await t.run((ctx) => addMember(ctx, circleId, "o@example.com", "Other Member"));
    mockCurrentUser.mockResolvedValue(maya.user);

    await expect(
      t.mutation(api.members.removeMember, { circleId, memberId: other.memberId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.memberRemoveForbidden),
    });
  });

  it("rejects a Removed Member with Circle not found", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const removed = await t.run((ctx) =>
      addMember(ctx, circleId, "r@example.com", "Rex Removed", "removed"),
    );
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(removed.user);

    await expect(
      t.mutation(api.members.removeMember, { circleId, memberId: maya.memberId }),
    ).rejects.toThrow(/circle\.unavailable/);
  });

  it("rejects a memberId from a different Circle with Member not found", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCompletedCircle(ctx));
    const otherCircle = await t.run((ctx) => seedCompletedCircle(ctx));
    const outsider = await t.run((ctx) =>
      addMember(ctx, otherCircle.circleId, "o@example.com", "Other Member"),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.members.removeMember, { circleId, memberId: outsider.memberId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.memberNotFound),
    });
  });

  it("rejects removing the Owner's membership row", async () => {
    const t = convexTest(schema, modules);
    const { owner, ownerMemberId, circleId } = await t.run((ctx) => seedCompletedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.members.removeMember, { circleId, memberId: ownerMemberId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.memberCannotRemoveOwner),
    });
  });

  it("rejects removal from a Personal Circle with member.notFound", async () => {
    const t = convexTest(schema, modules);
    const { owner, ownerMemberId, circleId } = await t.run((ctx) =>
      seedCircle(ctx, { kind: "personal" }),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.members.removeMember, { circleId, memberId: ownerMemberId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.memberNotFound),
    });
  });

  it("rejects removal from an archived Circle with circle.archived", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx, { archived: true }));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.members.removeMember, { circleId, memberId: maya.memberId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleArchived),
    });
  });

  it("rejects a missing memberId with Member not found", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCompletedCircle(ctx));
    const ghost = await t.run(async (ctx) => {
      const maya = await addMember(ctx, circleId, "m@example.com", "Maya Member");
      await ctx.db.delete(maya.memberId);
      return maya.memberId;
    });
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.members.removeMember, { circleId, memberId: ghost }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.memberNotFound),
    });
  });

  it("rejects removing an already-removed Member", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCompletedCircle(ctx));
    const removed = await t.run((ctx) =>
      addMember(ctx, circleId, "r@example.com", "Rex Removed", "removed"),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.members.removeMember, { circleId, memberId: removed.memberId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.memberNotFound),
    });
  });

  it("rejects removing a Member whose app User is already deleted", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCompletedCircle(ctx));
    const maya = await t.run(async (ctx) => {
      const seeded = await addMember(ctx, circleId, "gone@example.com", "Gone Member");
      await ctx.db.delete(seeded.user._id);
      return seeded;
    });
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.members.removeMember, { circleId, memberId: maya.memberId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.memberNotFound),
    });
  });

  it("rejects an incomplete regular Circle without Member/History/Notification/blocker changes", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    const blockersBefore = await t.run(
      async (ctx) => (await ctx.db.get(circleId))?.accountDeletionBlocked,
    );
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.members.removeMember, { circleId, memberId: maya.memberId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleSetupIncomplete),
    });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(maya.memberId))?.status).toBe("active");
      expect(await listEntityHistory(ctx, circleEntity(circleId))).toHaveLength(0);
      expect(await listNotificationsForUser(ctx, maya.user._id)).toHaveLength(0);
      expect((await ctx.db.get(circleId))?.accountDeletionBlocked).toBe(blockersBefore);
    });
  });
});

describe("removeMember — frozen identity and live list", () => {
  it("leaves displayName/image unchanged and skips setUserDisplayName on the removed row", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCompletedCircle(ctx));
    const maya = await t.run(async (ctx) => {
      const seeded = await addMember(ctx, circleId, "m@example.com", "Maya Member");
      await ctx.db.patch(seeded.memberId, { image: "https://example.com/maya.png" });
      return seeded;
    });
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.members.removeMember, { circleId, memberId: maya.memberId });
    await t.run((ctx) => setUserDisplayName(ctx, maya.user._id, "New Name"));

    await t.run(async (ctx) => {
      const row = await ctx.db.get(maya.memberId);
      expect(row?.displayName).toBe("Maya Member");
      expect(row?.image).toBe("https://example.com/maya.png");
    });
  });

  it("collapses resolveCircleAccess for the removed user", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCompletedCircle(ctx));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.members.removeMember, { circleId, memberId: maya.memberId });
    mockCurrentUser.mockResolvedValue(maya.user);

    const access = await t.run((ctx) => resolveCircleAccess(ctx, circleId));
    expect(access).toBeNull();
  });

  it("drops the removed member from the default list and includes them when asked", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCompletedCircle(ctx));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.members.removeMember, { circleId, memberId: maya.memberId });

    const active = await t.query(api.members.listMembers, { circleId });
    expect(active?.map((m) => m.displayName)).toEqual(["Olive Owner"]);

    const all = await t.query(api.members.listMembers, { circleId, includeHistorical: true });
    const removedView = all?.find((m) => m.id === maya.memberId);
    expect(removedView?.status).toBe("removed");
    expect(removedView?.displayName).toBe("Maya Member");
  });

  it("records exactly one member removed history event with the frozen display name", async () => {
    const t = convexTest(schema, modules);
    const { owner, ownerMemberId, circleId } = await t.run((ctx) => seedCompletedCircle(ctx));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.members.removeMember, { circleId, memberId: maya.memberId });

    await t.run(async (ctx) => {
      const events = await listEntityHistory(ctx, circleEntity(circleId));
      expect(events).toHaveLength(1);
      expect(events[0]?.action).toBe("member removed");
      expect(events[0]?.actorMemberId).toBe(ownerMemberId);
      expect(events[0]?.changes).toEqual([{ field: "member", from: "Maya Member" }]);
    });
  });
});

describe("leaveCircle — happy path", () => {
  it("flips the caller's member row to removed with frozen identity and records history", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(maya.user);

    const beforeLeave = Date.now();
    await t.mutation(api.members.leaveCircle, { circleId });

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", circleId).eq("userId", maya.user._id),
        )
        .unique();
      expect(row?.status).toBe("removed");
      expect(row?.removedAt).toBeGreaterThanOrEqual(beforeLeave);
      expect(row?.displayName).toBe("Maya Member");
      expect(row?.image).toBeUndefined();

      const events = await listEntityHistory(ctx, circleEntity(circleId));
      const event = events.find((entry) => entry.action === "member left");
      expect(event?.actorMemberId).toBe(maya.memberId);
      expect(event?.changes).toEqual([{ field: "member", from: "Maya Member" }]);
      for (const change of event?.changes ?? []) {
        expect(JSON.stringify(change)).not.toMatch(/[a-z0-9]{20,}/i);
      }
    });
  });

  it("lets a non-owner leave an incomplete regular Circle", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(maya.user);

    await t.mutation(api.members.leaveCircle, { circleId });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(circleId))?.setupCompletedAt).toBeNull();
      expect((await ctx.db.get(maya.memberId))?.status).toBe("removed");
    });
  });

  it("drops the Circle from listMyCircles and revokes access reactively", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(maya.user);

    await t.mutation(api.members.leaveCircle, { circleId });

    mockCurrentUser.mockResolvedValue(maya.user);
    const circles = await t.query(api.circles.listMyCircles, {});
    expect(circles?.some((circle) => circle.id === circleId)).toBe(false);

    await t.run(async (ctx) => {
      mockCurrentUser.mockResolvedValue(maya.user);
      expect(await resolveCircleAccess(ctx, circleId)).toBeNull();
    });
  });
});

describe("leaveCircle — guards", () => {
  it("rejects the Owner with a coded error", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(t.mutation(api.members.leaveCircle, { circleId })).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.ownerMustTransfer),
    });
  });

  it("rejects a Personal Circle with a coded error", async () => {
    const t = convexTest(schema, modules);
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx, { kind: "personal" }));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(t.mutation(api.members.leaveCircle, { circleId })).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.leavePersonalCircle),
    });
  });

  it("rejects a non-member with Circle not found", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const stranger = await t.run((ctx) => makeUser(ctx, "s@example.com", "Sam Stranger"));
    mockCurrentUser.mockResolvedValue(stranger);

    await expect(t.mutation(api.members.leaveCircle, { circleId })).rejects.toThrow(
      /circle\.unavailable/,
    );
  });

  it("rejects an unauthenticated caller with Circle not found", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(null);

    await expect(t.mutation(api.members.leaveCircle, { circleId })).rejects.toThrow(
      /circle\.unavailable/,
    );
  });

  it("rejects a removed member with Circle not found", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const removed = await t.run((ctx) =>
      addMember(ctx, circleId, "removed@example.com", "Rex Removed", "removed"),
    );
    mockCurrentUser.mockResolvedValue(removed.user);

    await expect(t.mutation(api.members.leaveCircle, { circleId })).rejects.toThrow(
      /circle\.unavailable/,
    );
  });
});

describe("leaveCircle — frozen identity and rejoin", () => {
  it("keeps displayName frozen after a profile update", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(maya.user);

    await t.mutation(api.members.leaveCircle, { circleId });

    await t.run(async (ctx) => {
      await setUserDisplayName(ctx, maya.user._id, "New Name");
      const row = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", circleId).eq("userId", maya.user._id),
        )
        .unique();
      expect(row?.displayName).toBe("Maya Member");
    });
  });

  it("reactivates the same member row on rejoin", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const maya = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya Member"));
    mockCurrentUser.mockResolvedValue(maya.user);

    await t.mutation(api.members.leaveCircle, { circleId });

    await t.run(async (ctx) => {
      const removed = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", circleId).eq("userId", maya.user._id),
        )
        .unique();
      expect(removed?._id).toBe(maya.memberId);

      await ctx.db.patch(maya.memberId, { status: "active", removedAt: undefined });
      const reactivated = await ctx.db.get(maya.memberId);
      expect(reactivated?._id).toBe(maya.memberId);
      expect(reactivated?.status).toBe("active");
    });
  });
});
