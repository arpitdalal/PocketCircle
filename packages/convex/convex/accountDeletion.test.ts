import { MUTATION_ERRORS, mutationErrorData } from "@pocketcircle/domain";
import { ConvexError } from "convex/values";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failNextTableInserts } from "../test/db-syscall-fault.js";
import { drainScheduledFunctions, mutateAndDrain } from "../test/mutateAndDrain.js";
import { registerEmailWorkpool } from "../test/registerEmailWorkpool.js";
import {
  addMember,
  firstPage,
  makeUser,
  seedCircle,
  seedFeedbackEmailEvent,
  seedInvitation,
  seedInvitationEmailEvent,
  seedPersonalCircleOwner,
  seedTransaction,
} from "../test/seed.js";
import { enableSentryReporting, sentryNodeSdk } from "../test/sentry-boundary.js";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import {
  ACCOUNT_DELETION_BATCH_SIZE,
  assertNoAccountDeletionBlockers,
  finalizeOnUserDelete,
} from "./accountDeletion.js";
import {
  accountDeletionBlockerFields,
  recomputeAccountDeletionBlockers,
} from "./accountDeletionBlockers.js";
import { circleSetupFields } from "./circleSetup.js";
import { circleEntity, listEntityHistory, recordEvent } from "./history.js";
import schema from "./schema.js";

const { mockCurrentUser } = vi.hoisted(() => ({
  mockCurrentUser: vi.fn(),
}));
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function completeSetup(ctx: MutationCtx, circleId: Id<"circles">) {
  await ctx.db.patch(circleId, circleSetupFields(Date.now()));
  await recomputeAccountDeletionBlockers(ctx, circleId);
}

describe("accountDeletionBlockerFields", () => {
  it("covers every Product Contract ownership row", () => {
    expect(
      accountDeletionBlockerFields({ kind: "personal", status: "active", setupCompletedAt: 1 }, 1),
    ).toEqual({ accountDeletionBlocked: false, accountDeletionBlockerAction: undefined });

    expect(
      accountDeletionBlockerFields({ kind: "regular", status: "active", setupCompletedAt: 1 }, 2),
    ).toEqual({ accountDeletionBlocked: true, accountDeletionBlockerAction: "transfer" });

    expect(
      accountDeletionBlockerFields({ kind: "regular", status: "archived", setupCompletedAt: 1 }, 2),
    ).toEqual({ accountDeletionBlocked: true, accountDeletionBlockerAction: "transfer" });

    expect(
      accountDeletionBlockerFields({ kind: "regular", status: "active", setupCompletedAt: 1 }, 1),
    ).toEqual({ accountDeletionBlocked: true, accountDeletionBlockerAction: "archive" });

    expect(
      accountDeletionBlockerFields(
        { kind: "regular", status: "active", setupCompletedAt: null },
        1,
      ),
    ).toEqual({ accountDeletionBlocked: false, accountDeletionBlockerAction: undefined });

    expect(
      accountDeletionBlockerFields({ kind: "regular", status: "archived", setupCompletedAt: 1 }, 1),
    ).toEqual({ accountDeletionBlocked: false, accountDeletionBlockerAction: undefined });

    expect(
      accountDeletionBlockerFields(
        { kind: "regular", status: "active", setupCompletedAt: null },
        2,
      ),
    ).toEqual({ accountDeletionBlocked: true, accountDeletionBlockerAction: "transfer" });
  });

  it("still sees a living co-member after nine stale active rows", async () => {
    const t = createTestConvex();
    const { circleId } = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await completeSetup(ctx, seed.circleId);
      // Nine status=active rows whose Users are already gone — previously a
      // limit+8 overfetch would miss the living co-member that follows.
      for (let i = 0; i < 9; i += 1) {
        const stale = await makeUser(ctx, `stale-${i}@example.com`, `Stale ${i}`);
        await ctx.db.insert("members", {
          circleId: seed.circleId,
          userId: stale._id,
          role: "member",
          status: "active",
          displayName: stale.displayName,
          joinedAt: Date.now(),
        });
        await ctx.db.delete(stale._id);
      }
      await addMember(ctx, seed.circleId, "alive@example.com", "Alive");
      await recomputeAccountDeletionBlockers(ctx, seed.circleId);
      return seed;
    });

    await t.run(async (ctx) => {
      const circle = await ctx.db.get(circleId);
      expect(circle?.accountDeletionBlocked).toBe(true);
      expect(circle?.accountDeletionBlockerAction).toBe("transfer");
    });
  });
});

describe("listAccountDeletionBlockers", () => {
  it("returns archive and transfer actions with refs", async () => {
    const t = createTestConvex();
    const { owner, circleId: archiveId } = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await completeSetup(ctx, seed.circleId);
      return seed;
    });
    const transferId = await t.run(async (ctx) => {
      const circleId = await ctx.db.insert("circles", {
        name: "Shared",
        kind: "regular",
        currency: "USD",
        color: "blue",
        mark: "S",
        ownerUserId: owner._id,
        creatorUserId: owner._id,
        status: "active",
        ...circleSetupFields(Date.now()),
        currencyLocked: false,
        ...accountDeletionBlockerFields(
          { kind: "regular", status: "active", setupCompletedAt: Date.now() },
          1,
        ),
        createdAt: Date.now(),
      });
      await ctx.db.insert("members", {
        circleId,
        userId: owner._id,
        role: "owner",
        status: "active",
        displayName: owner.displayName,
        joinedAt: Date.now(),
      });
      await addMember(ctx, circleId, "co@example.com", "Co Member");
      return circleId;
    });
    mockCurrentUser.mockResolvedValue(owner);

    const page = await t.query(api.accountDeletion.listAccountDeletionBlockers, firstPage(10));
    expect(page.page).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          circleId: archiveId,
          name: "Trip",
          action: "archive",
          ref: expect.stringContaining(archiveId),
        }),
        expect.objectContaining({
          circleId: transferId,
          name: "Shared",
          action: "transfer",
          ref: expect.stringContaining(transferId),
        }),
      ]),
    );
  });
});

describe("enqueueDeletionVerificationEmail", () => {
  it("rejects when blockers exist", async () => {
    const t = createTestConvex();
    const { owner } = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await completeSetup(ctx, seed.circleId);
      return seed;
    });

    await expect(
      t.mutation(internal.accountDeletion.enqueueDeletionVerificationEmail, {
        mappedUserId: owner._id,
        email: owner.email,
        displayName: owner.displayName,
        token: "tok-1",
      }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.accountDeletionBlocked),
    });

    await t.run(async (ctx) => {
      expect(
        await ctx.db
          .query("e2eAccountDeletionTokens")
          .withIndex("by_user", (q) => q.eq("userId", owner._id))
          .unique(),
      ).toBeNull();
    });
  });

  it("enqueues email and stashes E2E token when unblocked", async () => {
    vi.stubEnv("E2E_TEST_AUTH", "1");
    vi.stubEnv("SITE_URL", "https://app.example.com");
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("RESEND_FROM_EMAIL", "PocketCircle <onboarding@example.com>");
    const t = createTestConvex();
    const { owner } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "deleteme@example.com",
        displayName: "Delete Me",
        onboarded: true,
      }),
    );

    await mutateAndDrain(t, () =>
      t.mutation(internal.accountDeletion.enqueueDeletionVerificationEmail, {
        mappedUserId: owner._id,
        email: owner.email,
        displayName: owner.displayName,
        token: "verify-token-abc",
      }),
    );

    await t.run(async (ctx) => {
      const stash = await ctx.db
        .query("e2eAccountDeletionTokens")
        .withIndex("by_user", (q) => q.eq("userId", owner._id))
        .unique();
      expect(stash?.token).toBe("verify-token-abc");
    });
  });
});

describe("finalizeOnUserDelete", () => {
  it("rejects when a blocker appears after email issuance", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run(async (ctx) => {
      await completeSetup(ctx, circleId);
    });

    await expect(
      t.run((ctx) =>
        finalizeOnUserDelete(ctx, {
          email: owner.email,
          userId: owner._id,
          name: owner.displayName,
        }),
      ),
    ).rejects.toBeInstanceOf(ConvexError);

    await t.run(async (ctx) => {
      expect(await ctx.db.get(owner._id)).not.toBeNull();
      expect(
        await ctx.db
          .query("accountDeletionJobs")
          .withIndex("by_user", (q) => q.eq("userId", owner._id))
          .first(),
      ).toBeNull();
    });
  });

  it("creates a cleanup job, deletes the app User, and denies access immediately", async () => {
    const t = createTestConvex();
    const { owner, userId, personalCircleId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "gone@example.com",
        displayName: "Gone User",
        image: "https://example.com/a.png",
        onboarded: true,
      }),
    );
    const host = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await completeSetup(ctx, seed.circleId);
      const memberId = await ctx.db.insert("members", {
        circleId: seed.circleId,
        userId,
        role: "member",
        status: "active",
        displayName: owner.displayName,
        image: owner.image,
        joinedAt: Date.now(),
      });
      await recomputeAccountDeletionBlockers(ctx, seed.circleId);
      await ctx.db.insert("homeSummaryExclusions", {
        userId,
        circleId: seed.circleId,
        excludedAt: Date.now(),
      });
      return { ...seed, memberId };
    });

    await mutateAndDrain(t, () =>
      t.run((ctx) =>
        finalizeOnUserDelete(ctx, {
          email: owner.email,
          userId,
          name: owner.displayName,
        }),
      ),
    );

    await t.run(async (ctx) => {
      expect(await ctx.db.get(userId)).toBeNull();
      const job = await ctx.db
        .query("accountDeletionJobs")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .first();
      // Job deleted when cleanup finishes.
      expect(job).toBeNull();
      expect(await ctx.db.get(personalCircleId)).toBeNull();
      expect(
        await ctx.db
          .query("userActivation")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .first(),
      ).toBeNull();
      expect(
        await ctx.db
          .query("homeSummaryExclusions")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .first(),
      ).toBeNull();

      const member = await ctx.db.get(host.memberId);
      expect(member?.status).toBe("deleted");
      expect(member?.displayName).toBe("Gone User");
      expect(member?.image).toBeUndefined();
    });

    mockCurrentUser.mockResolvedValue(null);
    await expect(t.query(api.users.getCurrentUser, {})).resolves.toBeNull();

    mockCurrentUser.mockResolvedValue(host.owner);
    const members = await t.query(api.members.listMembers, { circleId: host.circleId });
    expect(members?.some((m) => m.id === host.memberId)).toBe(false);

    const historical = await t.query(api.members.listMembers, {
      circleId: host.circleId,
      includeHistorical: true,
    });
    const deleted = historical?.find((m) => m.id === host.memberId);
    expect(deleted?.status).toBe("deleted");
    expect(deleted?.image).toBeUndefined();
    expect(deleted?.displayName).toBe("Gone User");
  });

  it("treats User absence as Deleted Member before physical conversion", async () => {
    const t = createTestConvex();
    const { owner, userId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "tombstone@example.com",
        displayName: "Tombstone",
        image: "https://example.com/t.png",
        onboarded: true,
      }),
    );
    const host = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await completeSetup(ctx, seed.circleId);
      const memberId = await ctx.db.insert("members", {
        circleId: seed.circleId,
        userId,
        role: "member",
        status: "active",
        displayName: owner.displayName,
        image: owner.image,
        joinedAt: Date.now(),
      });
      await recomputeAccountDeletionBlockers(ctx, seed.circleId);
      return { ...seed, memberId };
    });

    // Finalize without draining cleanup — physical Member conversion has not run yet.
    await t.run((ctx) =>
      finalizeOnUserDelete(ctx, {
        email: owner.email,
        userId,
        name: owner.displayName,
      }),
    );

    await t.run(async (ctx) => {
      expect(await ctx.db.get(userId)).toBeNull();
      const row = await ctx.db.get(host.memberId);
      expect(row?.status).toBe("active");
      expect(row?.image).toBe("https://example.com/t.png");
    });

    mockCurrentUser.mockResolvedValue(host.owner);
    const live = await t.query(api.members.listMembers, { circleId: host.circleId });
    expect(live?.some((m) => m.id === host.memberId)).toBe(false);

    const historical = await t.query(api.members.listMembers, {
      circleId: host.circleId,
      includeHistorical: true,
    });
    const deleted = historical?.find((m) => m.id === host.memberId);
    expect(deleted?.status).toBe("deleted");
    expect(deleted?.image).toBeUndefined();
    expect(deleted?.displayName).toBe("Tombstone");

    await drainScheduledFunctions(t);
  });
});

describe("cleanup phases", () => {
  it("converts active and removed memberships once with History and no Notifications", async () => {
    const t = createTestConvex();
    const deleting = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "member@example.com",
        displayName: "Maya Member",
        image: "https://example.com/m.png",
        onboarded: true,
      }),
    );
    const host = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await completeSetup(ctx, seed.circleId);
      const activeId = await ctx.db.insert("members", {
        circleId: seed.circleId,
        userId: deleting.userId,
        role: "member",
        status: "active",
        displayName: "Maya Member",
        image: "https://example.com/m.png",
        joinedAt: Date.now(),
      });
      await recomputeAccountDeletionBlockers(ctx, seed.circleId);
      return { ...seed, activeId };
    });
    const otherHost = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await completeSetup(ctx, seed.circleId);
      await ctx.db.patch(seed.circleId, { name: "Other", mark: "O" });
      const removedId = await ctx.db.insert("members", {
        circleId: seed.circleId,
        userId: deleting.userId,
        role: "member",
        status: "removed",
        displayName: "Maya Member",
        image: "https://example.com/m.png",
        joinedAt: Date.now() - 1000,
        removedAt: Date.now() - 500,
      });
      return { ...seed, removedId };
    });
    const hostNotifBefore = await t.run(async (ctx) => {
      await ctx.db.insert("notifications", {
        userId: host.owner._id,
        type: "member.removed",
        title: "Keep me",
        read: false,
        createdAt: Date.now(),
      });
      return (
        await ctx.db
          .query("notifications")
          .withIndex("by_user", (q) => q.eq("userId", host.owner._id))
          .collect()
      ).length;
    });

    await mutateAndDrain(t, () =>
      t.run((ctx) =>
        finalizeOnUserDelete(ctx, {
          email: deleting.owner.email,
          userId: deleting.userId,
          name: deleting.owner.displayName,
        }),
      ),
    );

    await t.run(async (ctx) => {
      const active = await ctx.db.get(host.activeId);
      expect(active?.status).toBe("deleted");
      expect(active?.removedAt).toBeUndefined();
      const removed = await ctx.db.get(otherHost.removedId);
      expect(removed?.status).toBe("deleted");
      expect(removed?.removedAt).toEqual(expect.any(Number));

      const events = await listEntityHistory(ctx, circleEntity(host.circleId));
      const deletedEvents = events.filter((e) => e.action === "member deleted");
      expect(deletedEvents).toHaveLength(1);
      expect(deletedEvents[0]?.actorMemberId).toBeUndefined();

      const otherEvents = await listEntityHistory(ctx, circleEntity(otherHost.circleId));
      expect(otherEvents.filter((e) => e.action === "member deleted")).toHaveLength(1);

      const hostNotifs = await ctx.db
        .query("notifications")
        .withIndex("by_user", (q) => q.eq("userId", host.owner._id))
        .collect();
      expect(hostNotifs).toHaveLength(hostNotifBefore);
    });
  });

  it("converts more than one batch of active memberships without duplicate History", async () => {
    const t = createTestConvex();
    const deleting = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "batch-member@example.com",
        displayName: "Batch Member",
        onboarded: true,
      }),
    );
    const memberCount = ACCOUNT_DELETION_BATCH_SIZE + 5;
    const hostCircleIds = await t.run(async (ctx) => {
      const ids: Id<"circles">[] = [];
      for (let i = 0; i < memberCount; i += 1) {
        const seed = await seedCircle(ctx);
        await completeSetup(ctx, seed.circleId);
        await ctx.db.patch(seed.circleId, { name: `Host ${i}`, mark: String(i % 10) });
        await ctx.db.insert("members", {
          circleId: seed.circleId,
          userId: deleting.userId,
          role: "member",
          status: "active",
          displayName: "Batch Member",
          joinedAt: Date.now(),
        });
        await recomputeAccountDeletionBlockers(ctx, seed.circleId);
        ids.push(seed.circleId);
      }
      return ids;
    });

    const jobId = await t.run(async (ctx) => {
      await ctx.db.delete(deleting.userId);
      return await ctx.db.insert("accountDeletionJobs", {
        userId: deleting.userId,
        emailLower: deleting.owner.email,
        finalizedAt: Date.now(),
        phase: "convertActiveMemberships",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    await mutateAndDrain(t, () => t.mutation(internal.accountDeletion.runCleanupBatch, { jobId }));

    await t.run(async (ctx) => {
      const remainingActive = await ctx.db
        .query("members")
        .withIndex("by_user_and_status", (q) =>
          q.eq("userId", deleting.userId).eq("status", "active"),
        )
        .collect();
      expect(remainingActive).toHaveLength(0);

      let deletedEvents = 0;
      for (const circleId of hostCircleIds) {
        const events = await listEntityHistory(ctx, circleEntity(circleId));
        deletedEvents += events.filter((e) => e.action === "member deleted").length;
      }
      expect(deletedEvents).toBe(memberCount);
    });
  });

  it("leaves surviving Circle History unchanged except new deletion events", async () => {
    const t = createTestConvex();
    const deleting = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "history@example.com",
        displayName: "History Member",
        image: "https://example.com/h.png",
        onboarded: true,
      }),
    );
    const host = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await completeSetup(ctx, seed.circleId);
      await ctx.db.insert("members", {
        circleId: seed.circleId,
        userId: deleting.userId,
        role: "member",
        status: "active",
        displayName: "History Member",
        image: "https://example.com/h.png",
        joinedAt: Date.now(),
      });
      await recomputeAccountDeletionBlockers(ctx, seed.circleId);
      const ownerMember = await ctx.db.get(seed.ownerMemberId);
      if (!ownerMember) {
        throw new Error("missing owner member");
      }
      // Existing History that Account Deletion must not rewrite.
      await recordEvent(ctx, {
        entity: circleEntity(seed.circleId),
        actor: ownerMember,
        action: "circle created",
        changes: [{ field: "name", to: "Shared Host" }],
      });
      return seed;
    });

    const before = await t.run(async (ctx) => {
      const events = await listEntityHistory(ctx, circleEntity(host.circleId));
      return events.map((e) => ({
        action: e.action,
        actorMemberId: e.actorMemberId,
        changes: e.changes,
        createdAt: e.createdAt,
        _id: e._id,
      }));
    });
    expect(before.length).toBeGreaterThan(0);

    await mutateAndDrain(t, () =>
      t.run((ctx) =>
        finalizeOnUserDelete(ctx, {
          email: deleting.owner.email,
          userId: deleting.userId,
          name: deleting.owner.displayName,
        }),
      ),
    );

    await t.run(async (ctx) => {
      const after = await listEntityHistory(ctx, circleEntity(host.circleId));
      for (const prior of before) {
        const match = after.find((e) => e._id === prior._id);
        expect(match).toEqual(expect.objectContaining(prior));
      }
      expect(after.filter((e) => e.action === "member deleted")).toHaveLength(1);
      expect(after).toHaveLength(before.length + 1);
    });
  });

  it("revokes inviter and invitee pending Invitations once; post-finalizedAt invites survive", async () => {
    const t = createTestConvex();
    const deleting = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "invitee@example.com",
        displayName: "Invitee",
        onboarded: true,
      }),
    );
    const host = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await completeSetup(ctx, seed.circleId);
      const asInviter = await seedInvitation(ctx, seed.circleId, deleting.userId, {
        email: "other@example.com",
        createdAt: Date.now() - 10_000,
      });
      const asInvitee = await seedInvitation(ctx, seed.circleId, seed.owner._id, {
        email: "invitee@example.com",
        createdAt: Date.now() - 5_000,
      });
      return { ...seed, asInviter, asInvitee };
    });

    const finalizedAt = Date.now();
    const jobId = await t.run(async (ctx) => {
      await assertNoAccountDeletionBlockers(ctx, deleting.userId);
      return await ctx.db.insert("accountDeletionJobs", {
        userId: deleting.userId,
        emailLower: deleting.owner.email,
        finalizedAt,
        phase: "revokeInvitesByInviter",
        createdAt: finalizedAt,
        updatedAt: finalizedAt,
      });
    });

    // Post-finalizedAt invite must survive cleanup (created after the job's cutoff).
    await t.run(async (ctx) => {
      await seedInvitation(ctx, host.circleId, host.owner._id, {
        email: "invitee@example.com",
        createdAt: finalizedAt + 1_000,
      });
      await ctx.db.delete(deleting.userId);
    });

    await mutateAndDrain(t, () => t.mutation(internal.accountDeletion.resumeCleanup, { jobId }));

    await t.run(async (ctx) => {
      expect((await ctx.db.get(host.asInviter))?.status).toBe("revoked");
      expect((await ctx.db.get(host.asInvitee))?.status).toBe("revoked");
      const surviving = await ctx.db
        .query("invitations")
        .withIndex("by_circle_and_email", (q) =>
          q.eq("circleId", host.circleId).eq("emailLower", "invitee@example.com"),
        )
        .collect();
      expect(surviving.some((i) => i.status === "pending" && i.createdAt > finalizedAt)).toBe(true);

      const events = await listEntityHistory(ctx, circleEntity(host.circleId));
      expect(events.filter((e) => e.action === "invitation revoked")).toHaveLength(2);
    });
  });

  it("rejects accepting a pending invitation invalidated by an in-flight deletion job", async () => {
    const t = createTestConvex();
    const host = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await completeSetup(ctx, seed.circleId);
      return seed;
    });
    const invitee = await t.run((ctx) =>
      makeUser(ctx, "pending-invitee@example.com", "Pending Invitee"),
    );
    const known = await t.run(async (ctx) => {
      const { generateInvitationToken, hashInvitationToken } = await import("./invitationToken.js");
      const token = generateInvitationToken();
      const invitationId = await ctx.db.insert("invitations", {
        circleId: host.circleId,
        emailLower: invitee.email.toLowerCase(),
        tokenHash: await hashInvitationToken(token),
        status: "pending",
        invitedByUserId: host.owner._id,
        resendCount: 0,
        resendTimestamps: [],
        createdAt: Date.now() - 500,
        expiresAt: Date.now() + 86_400_000,
      });
      // Job exists before physical revocation — acceptance must fail immediately.
      await ctx.db.insert("accountDeletionJobs", {
        userId: host.owner._id,
        emailLower: host.owner.email,
        finalizedAt: Date.now(),
        phase: "revokeInvitesByInviter",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return { token, invitationId };
    });

    mockCurrentUser.mockResolvedValue(invitee);
    await expect(
      t.mutation(api.invitations.acceptInvitation, { token: known.token }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteInvalid),
    });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(known.invitationId))?.status).toBe("pending");
    });
  });

  it("deletes only the deleted User's Notifications and user-scoped email events", async () => {
    const t = createTestConvex();
    const deleting = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "solo@example.com",
        displayName: "Solo",
        onboarded: true,
      }),
    );
    const other = await t.run((ctx) => makeUser(ctx, "keep@example.com", "Keep"));
    await t.run(async (ctx) => {
      await ctx.db.insert("notifications", {
        userId: deleting.userId,
        type: "invitation.accepted",
        title: "Mine",
        read: false,
        createdAt: Date.now(),
      });
      await ctx.db.insert("notifications", {
        userId: other._id,
        type: "invitation.accepted",
        title: "Theirs",
        read: false,
        createdAt: Date.now(),
      });
      await seedFeedbackEmailEvent(ctx, {
        userId: deleting.userId,
        type: "bug",
        sentAt: Date.now(),
      });
      await seedInvitationEmailEvent(ctx, {
        invitedByUserId: deleting.userId,
        circleId: deleting.personalCircleId,
        emailLower: "x@example.com",
        kind: "create",
        sentAt: Date.now(),
      });
    });

    await mutateAndDrain(t, () =>
      t.run((ctx) =>
        finalizeOnUserDelete(ctx, {
          email: deleting.owner.email,
          userId: deleting.userId,
          name: deleting.owner.displayName,
        }),
      ),
    );

    await t.run(async (ctx) => {
      expect(
        await ctx.db
          .query("notifications")
          .withIndex("by_user", (q) => q.eq("userId", deleting.userId))
          .collect(),
      ).toHaveLength(0);
      expect(
        await ctx.db
          .query("notifications")
          .withIndex("by_user", (q) => q.eq("userId", other._id))
          .collect(),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .query("feedbackEmailEvents")
          .withIndex("by_user_and_sentAt", (q) => q.eq("userId", deleting.userId))
          .collect(),
      ).toHaveLength(0);
      expect(
        await ctx.db
          .query("invitationEmailEvents")
          .withIndex("by_user_and_sentAt", (q) => q.eq("invitedByUserId", deleting.userId))
          .collect(),
      ).toHaveLength(0);
    });
  });

  it("deletes Personal / solo setup-incomplete / solo archived Circles including multi-batch data", async () => {
    const t = createTestConvex();
    const deleting = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "owner@example.com",
        displayName: "Owner",
        onboarded: true,
      }),
    );
    const incomplete = await t.run(async (ctx) => {
      const now = Date.now();
      const circleId = await ctx.db.insert("circles", {
        name: "Incomplete",
        kind: "regular",
        currency: "USD",
        color: "blue",
        mark: "I",
        ownerUserId: deleting.userId,
        creatorUserId: deleting.userId,
        status: "active",
        ...circleSetupFields(null),
        currencyLocked: false,
        ...accountDeletionBlockerFields(
          { kind: "regular", status: "active", setupCompletedAt: null },
          1,
        ),
        createdAt: now,
      });
      const ownerMemberId = await ctx.db.insert("members", {
        circleId,
        userId: deleting.userId,
        role: "owner",
        status: "active",
        displayName: deleting.owner.displayName,
        joinedAt: now,
      });
      const groceriesId = await ctx.db.insert("categories", {
        circleId,
        name: "Groceries",
        nameLower: "groceries",
        type: "expense",
        color: "green",
        creatorUserId: deleting.userId,
        status: "active",
        createdAt: now,
      });
      const fixture = {
        owner: deleting.owner,
        ownerMemberId,
        circleId,
        groceriesId,
        diningId: groceriesId,
        salaryId: groceriesId,
      };
      for (let i = 0; i < ACCOUNT_DELETION_BATCH_SIZE + 5; i += 1) {
        await seedTransaction(ctx, fixture, { title: `t${i}`, date: "2026-05-01" });
      }
      return circleId;
    });
    const archived = await t.run(async (ctx) => {
      const now = Date.now();
      const circleId = await ctx.db.insert("circles", {
        name: "Archived Solo",
        kind: "regular",
        currency: "USD",
        color: "blue",
        mark: "A",
        ownerUserId: deleting.userId,
        creatorUserId: deleting.userId,
        status: "archived",
        ...circleSetupFields(now),
        currencyLocked: false,
        archivedAt: now,
        ...accountDeletionBlockerFields(
          { kind: "regular", status: "archived", setupCompletedAt: now },
          1,
        ),
        createdAt: now,
      });
      await ctx.db.insert("members", {
        circleId,
        userId: deleting.userId,
        role: "owner",
        status: "active",
        displayName: deleting.owner.displayName,
        joinedAt: now,
      });
      return circleId;
    });

    await mutateAndDrain(t, () =>
      t.run((ctx) =>
        finalizeOnUserDelete(ctx, {
          email: deleting.owner.email,
          userId: deleting.userId,
          name: deleting.owner.displayName,
        }),
      ),
    );

    await t.run(async (ctx) => {
      expect(await ctx.db.get(deleting.personalCircleId)).toBeNull();
      expect(await ctx.db.get(incomplete)).toBeNull();
      expect(await ctx.db.get(archived)).toBeNull();
      expect(
        await ctx.db
          .query("transactions")
          .withIndex("by_circle", (q) => q.eq("circleId", incomplete))
          .first(),
      ).toBeNull();
      expect(
        await ctx.db
          .query("transactionSearchDocuments")
          .withIndex("by_circle", (q) => q.eq("circleId", incomplete))
          .first(),
      ).toBeNull();
      expect(
        await ctx.db
          .query("transactionCategories")
          .withIndex("by_circle", (q) => q.eq("circleId", incomplete))
          .first(),
      ).toBeNull();
      expect(
        await ctx.db
          .query("histories")
          .withIndex("by_circle", (q) => q.eq("circleId", incomplete))
          .first(),
      ).toBeNull();
      expect(
        await ctx.db
          .query("accountDeletionJobs")
          .withIndex("by_user", (q) => q.eq("userId", deleting.userId))
          .first(),
      ).toBeNull();
    });
  });

  it("resumeCleanup is idempotent after completion", async () => {
    const t = createTestConvex();
    const deleting = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "resume@example.com",
        displayName: "Resume",
        onboarded: true,
      }),
    );
    const jobId = await mutateAndDrain(t, () =>
      t.run(async (ctx) => {
        const id = await ctx.db.insert("accountDeletionJobs", {
          userId: deleting.userId,
          emailLower: deleting.owner.email,
          finalizedAt: Date.now(),
          phase: "deleteOwnedCircles",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        await ctx.db.delete(deleting.userId);
        await ctx.scheduler.runAfter(0, internal.accountDeletion.runCleanupBatch, { jobId: id });
        return id;
      }),
    );

    await expect(t.mutation(internal.accountDeletion.resumeCleanup, { jobId })).resolves.toBeNull();
    await drainScheduledFunctions(t);
    await t.run(async (ctx) => {
      expect(await ctx.db.get(jobId)).toBeNull();
      expect(await ctx.db.get(deleting.personalCircleId)).toBeNull();
    });
  });

  it("persists, alerts, and resumes when a valid cleanup phase throws", async () => {
    enableSentryReporting();
    const t = createTestConvex();
    const deleting = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "phase-throw@example.com",
        displayName: "Phase Throw",
        onboarded: true,
      }),
    );
    const ownerMemberId = await t.run(async (ctx) => {
      const member = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", deleting.personalCircleId).eq("userId", deleting.userId),
        )
        .unique();
      if (!member) {
        throw new Error("missing owner member");
      }
      return member._id;
    });
    const jobId = await t.run(async (ctx) => {
      await ctx.db.delete(deleting.userId);
      return await ctx.db.insert("accountDeletionJobs", {
        userId: deleting.userId,
        emailLower: deleting.owner.email,
        finalizedAt: Date.now(),
        phase: "convertActiveMemberships",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const restoreSyscall = failNextTableInserts("histories", 1);
    try {
      await mutateAndDrain(t, () =>
        t.mutation(internal.accountDeletion.runCleanupBatch, { jobId }),
      );
    } finally {
      restoreSyscall();
    }

    const job = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(job?.phase).toBe("convertActiveMemberships");
    expect(job?.failure).toBe("histories insert failed");
    expect(sentryNodeSdk.captureEvent).toHaveBeenCalledOnce();
    const [event] = sentryNodeSdk.captureEvent.mock.calls[0] ?? [];
    expect(event).toMatchObject({
      message: "account_deletion_cleanup_failed",
      extra: { entityId: jobId, error: "histories insert failed" },
    });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(ownerMemberId))?.status).toBe("active");
      const events = await listEntityHistory(ctx, circleEntity(deleting.personalCircleId));
      expect(events.filter((e) => e.action === "member deleted")).toEqual([]);
    });

    await mutateAndDrain(t, () => t.mutation(internal.accountDeletion.resumeCleanup, { jobId }));
    await t.run(async (ctx) => {
      expect(await ctx.db.get(jobId)).toBeNull();
      expect(await ctx.db.get(deleting.personalCircleId)).toBeNull();
    });
  });
});

describe("Deleted Member reconnection", () => {
  it("does not reactivate a Deleted Member for a new User with the same email", async () => {
    const t = createTestConvex();
    const host = await t.run(async (ctx) => {
      const seed = await seedCircle(ctx);
      await completeSetup(ctx, seed.circleId);
      return seed;
    });
    const oldUserId = await t.run(async (ctx) => {
      const user = await makeUser(ctx, "same@example.com", "Old");
      await ctx.db.insert("members", {
        circleId: host.circleId,
        userId: user._id,
        role: "member",
        status: "deleted",
        displayName: "Old",
        joinedAt: Date.now(),
        deletedAt: Date.now(),
      });
      await ctx.db.delete(user._id);
      return user._id;
    });

    const fresh = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "same@example.com",
        displayName: "New Same",
        onboarded: true,
      }),
    );
    expect(fresh.userId).not.toBe(oldUserId);

    mockCurrentUser.mockResolvedValue(fresh.owner);
    const token = await t.run(async (ctx) => {
      const { generateInvitationToken, hashInvitationToken } = await import("./invitationToken.js");
      const raw = generateInvitationToken();
      await seedInvitation(ctx, host.circleId, host.owner._id, {
        email: "same@example.com",
        tokenHash: await hashInvitationToken(raw),
      });
      return raw;
    });

    await mutateAndDrain(t, () => t.mutation(api.invitations.acceptInvitation, { token }));

    await t.run(async (ctx) => {
      const members = await ctx.db
        .query("members")
        .withIndex("by_circle", (q) => q.eq("circleId", host.circleId))
        .collect();
      const deleted = members.find((m) => m.userId === oldUserId);
      const joined = members.find((m) => m.userId === fresh.userId);
      expect(deleted?.status).toBe("deleted");
      expect(joined?.status).toBe("active");
      expect(joined?._id).not.toBe(deleted?._id);
    });
  });
});
