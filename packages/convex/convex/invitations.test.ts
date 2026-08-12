import { CIRCLE_CAPACITY_LIMIT, MUTATION_ERRORS, mutationErrorData } from "@pocketcircle/domain";
import { capturedRequests, resetCapturedRequests } from "@pocketcircle/mocks";
import { ConvexError } from "convex/values";
import { convexTest as createConvexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mutateAndDrain } from "../test/mutateAndDrain.js";
import { listNotificationsForUser } from "../test/notifications.js";
import { registerEmailWorkpool } from "../test/registerEmailWorkpool.js";
import {
  addMember,
  makeUser,
  markCircleSetupComplete,
  seedCircle,
  seedFixture,
  seedInvitation,
  seedInvitationEmailEvent,
  seedPersonalCircleOwner,
  seedTransaction,
} from "../test/seed.js";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { circleEntity, listEntityHistory } from "./history.js";
import { generateInvitationToken, hashInvitationToken } from "./invitationToken.js";
import { createUserWithPersonalCircle } from "./model.js";
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

async function seedPendingInvitation(
  ctx: MutationCtx,
  opts: {
    circleId: Id<"circles">;
    email: string;
    invitedByUserId: Id<"users">;
    token?: string;
    expiresAt?: number;
    status?: "pending" | "accepted" | "revoked" | "expired";
  },
) {
  const token = opts.token ?? generateInvitationToken();
  const tokenHash = await hashInvitationToken(token);
  const now = Date.now();
  await ctx.db.insert("invitations", {
    circleId: opts.circleId,
    emailLower: opts.email.toLowerCase(),
    tokenHash,
    status: opts.status ?? "pending",
    invitedByUserId: opts.invitedByUserId,
    resendCount: 0,
    resendTimestamps: [],
    createdAt: now,
    expiresAt: opts.expiresAt ?? now + INVITE_TTL_MS,
  });
  return token;
}

function resendBodyHtml(body: unknown) {
  if (typeof body !== "object" || body === null || !("html" in body)) {
    throw new Error("expected Resend JSON body with html");
  }
  const { html } = body;
  if (typeof html !== "string") {
    throw new Error("expected Resend html field to be a string");
  }
  return html;
}

function inviteTokenFromHtml(html: string) {
  const tokenMatch = html.match(/\/invite\/([^"]+)"/);
  const token = tokenMatch?.[1];
  if (!token) {
    throw new Error("expected invite token in Resend email html");
  }
  return token;
}

beforeEach(() => {
  mockCurrentUser.mockReset();
  resetCapturedRequests();
});

afterEach(() => {
  vi.useRealTimers();
});

function createTestConvex() {
  const t = createConvexTest(schema, modules);
  registerEmailWorkpool(t);
  return t;
}

async function drainWorkpool(t: ReturnType<typeof createTestConvex>) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function inviteAndDrain(
  t: ReturnType<typeof createTestConvex>,
  args: { circleId: Id<"circles">; email: string },
) {
  vi.useFakeTimers();
  try {
    await t.mutation(api.invitations.createInvitation, args);
    await drainWorkpool(t);
  } finally {
    vi.useRealTimers();
  }
}

describe("createInvitation — happy path", () => {
  it("creates a pending invitation with hashed token and records history", async () => {
    vi.useFakeTimers();
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("RESEND_FROM_EMAIL", "no-reply@pocketcircle.test");

    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.invitations.createInvitation, {
      circleId,
      email: "ada@example.com",
    });
    await drainWorkpool(t);

    await t.run(async (ctx) => {
      const invites = await ctx.db
        .query("invitations")
        .withIndex("by_circle", (q) => q.eq("circleId", circleId))
        .collect();
      expect(invites).toHaveLength(1);
      const invite = invites[0];
      expect(invite?.status).toBe("pending");
      expect(invite?.emailLower).toBe("ada@example.com");
      expect(invite?.resendCount).toBe(0);
      expect(invite?.invitedByUserId).toBe(owner._id);
      expect(invite?.tokenHash).toBeTruthy();
      expect(invite?.expiresAt).toBe((invite?.createdAt ?? 0) + INVITE_TTL_MS);

      const events = await listEntityHistory(ctx, circleEntity(circleId));
      expect(events).toHaveLength(1);
      expect(events[0]?.action).toBe("member invited");
      expect(events[0]?.changes).toEqual([{ field: "email", to: "ada@example.com" }]);
    });

    const resend = capturedRequests.filter((r) => r.vendor === "resend");
    expect(resend).toHaveLength(1);
    expect(resend[0]?.body).toMatchObject({ to: "ada@example.com" });
    const html = resendBodyHtml(resend[0]?.body);
    const token = inviteTokenFromHtml(html);

    await t.run(async (ctx) => {
      const invite = await ctx.db
        .query("invitations")
        .withIndex("by_circle", (q) => q.eq("circleId", circleId))
        .first();
      expect(invite?.tokenHash).toBe(await hashInvitationToken(token));
    });

    vi.useRealTimers();
  });
});

describe("createInvitation — permissions", () => {
  it("rejects a non-owner Member", async () => {
    const t = createTestConvex();
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const member = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya"));
    mockCurrentUser.mockResolvedValue(member.user);

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "new@example.com" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteForbidden),
    });
  });

  it("rejects a removed Member with Circle not found", async () => {
    const t = createTestConvex();
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const removed = await t.run((ctx) =>
      addMember(ctx, circleId, "removed@example.com", "Removed", "removed"),
    );
    mockCurrentUser.mockResolvedValue(removed.user);

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "new@example.com" }),
    ).rejects.toThrow("Circle not found");
  });

  it("rejects a non-member with Circle not found", async () => {
    const t = createTestConvex();
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const stranger = await t.run((ctx) => makeUser(ctx, "stranger@example.com", "Stranger"));
    mockCurrentUser.mockResolvedValue(stranger);

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "new@example.com" }),
    ).rejects.toThrow("Circle not found");
  });

  it("rejects an unauthenticated caller with Circle not found", async () => {
    const t = createTestConvex();
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(null);

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "new@example.com" }),
    ).rejects.toThrow("Circle not found");
  });
});

describe("createInvitation — circle constraints", () => {
  it("rejects a Personal Circle", async () => {
    const t = createTestConvex();
    const { owner, personalCircleId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "owner@example.com",
        displayName: "Owner",
        currency: "USD",
      }),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.invitations.createInvitation, {
        circleId: personalCircleId,
        email: "new@example.com",
      }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.invitePersonalCircle),
    });
  });

  it("rejects an incomplete regular Circle", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "new@example.com" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleSetupIncomplete),
    });
  });

  it("succeeds once setup is complete", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    await inviteAndDrain(t, {
      circleId,
      email: "new@example.com",
    });
  });

  it("rejects an archived Circle", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx, { archived: true }));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "new@example.com" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleArchived),
    });
  });
});

describe("createInvitation — duplicates", () => {
  it("rejects an active Member's email", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const member = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya"));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: member.user.email }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteAlreadyMember),
    });
  });

  it("rejects an active member when the invite email differs only by case", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const memberUserId = await t.run((ctx) =>
      createUserWithPersonalCircle(ctx, {
        email: "Ada@Example.com",
        displayName: "Ada",
        currency: "USD",
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("members", {
        circleId,
        userId: memberUserId,
        role: "member",
        status: "active",
        displayName: "Ada",
        joinedAt: Date.now(),
      }),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "ada@example.com" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteAlreadyMember),
    });
  });

  it("rejects a pending unexpired invite for the same email", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    await inviteAndDrain(t, { circleId, email: "ada@example.com" });
    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "ada@example.com" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteAlreadyPending),
    });

    await t.run(async (ctx) => {
      const invites = await ctx.db
        .query("invitations")
        .withIndex("by_circle", (q) => q.eq("circleId", circleId))
        .collect();
      expect(invites).toHaveLength(1);
    });
  });

  it("allows re-inviting a removed Member's email", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const removed = await t.run((ctx) =>
      addMember(ctx, circleId, "removed@example.com", "Removed", "removed"),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await inviteAndDrain(t, {
      circleId,
      email: removed.user.email,
    });
  });

  it("allows a fresh invite when the prior one is expired", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("invitations", {
        circleId,
        emailLower: "ada@example.com",
        tokenHash: "old-hash",
        status: "pending",
        invitedByUserId: owner._id,
        resendCount: 0,
        resendTimestamps: [],
        createdAt: now - INVITE_TTL_MS - 1,
        expiresAt: now - 1,
      });
    });

    await inviteAndDrain(t, {
      circleId,
      email: "ada@example.com",
    });

    await t.run(async (ctx) => {
      const invites = await ctx.db
        .query("invitations")
        .withIndex("by_circle_and_email", (q) =>
          q.eq("circleId", circleId).eq("emailLower", "ada@example.com"),
        )
        .collect();
      expect(invites).toHaveLength(2);
    });
  });

  it("allows a fresh invite when the prior one is revoked or accepted", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const now = Date.now();
    for (const status of ["revoked", "accepted"] as const) {
      await t.run(async (ctx) => {
        await ctx.db.insert("invitations", {
          circleId,
          emailLower: `${status}@example.com`,
          tokenHash: `hash-${status}`,
          status,
          invitedByUserId: owner._id,
          resendCount: 0,
          resendTimestamps: [],
          createdAt: now,
          expiresAt: now + INVITE_TTL_MS,
        });
      });

      await inviteAndDrain(t, {
        circleId,
        email: `${status}@example.com`,
      });
    }
  });
});

describe("createInvitation — email normalization", () => {
  it("normalizes email and rejects a pending duplicate on emailLower", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    await inviteAndDrain(t, {
      circleId,
      email: "  Ada@Example.COM ",
    });

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "ada@example.com" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteAlreadyPending),
    });

    await t.run(async (ctx) => {
      const invite = await ctx.db
        .query("invitations")
        .withIndex("by_circle_and_email", (q) =>
          q.eq("circleId", circleId).eq("emailLower", "ada@example.com"),
        )
        .first();
      expect(invite?.emailLower).toBe("ada@example.com");
    });
  });
});

describe("createInvitation — email enqueue", () => {
  it("sends exactly one invitation email on success", async () => {
    vi.useFakeTimers();
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("RESEND_FROM_EMAIL", "no-reply@pocketcircle.test");

    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.invitations.createInvitation, {
      circleId,
      email: "ada@example.com",
    });
    await drainWorkpool(t);

    const resend = capturedRequests.filter((r) => r.vendor === "resend");
    expect(resend).toHaveLength(1);
    expect(resend[0]?.body).toMatchObject({ to: "ada@example.com" });
    const html = resendBodyHtml(resend[0]?.body);
    expect(html).toMatch(/\/invite\/[^"]+"/);

    vi.useRealTimers();
  });

  it("sends zero emails when createInvitation throws", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("RESEND_FROM_EMAIL", "no-reply@pocketcircle.test");

    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    await inviteAndDrain(t, { circleId, email: "ada@example.com" });
    resetCapturedRequests();

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "ada@example.com" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteAlreadyPending),
    });

    expect(capturedRequests.filter((r) => r.vendor === "resend")).toHaveLength(0);
  });
});

describe("createInvitation — coded errors", () => {
  it("throws ConvexError for owner-facing validation failures", async () => {
    const t = createTestConvex();
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const member = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya"));
    mockCurrentUser.mockResolvedValue(member.user);

    try {
      await t.mutation(api.invitations.createInvitation, { circleId, email: "x@example.com" });
      expect.unreachable("expected forbidden");
    } catch (error) {
      expect(error).toBeInstanceOf(ConvexError);
    }
  });
});

describe("createInvitation — daily cap", () => {
  it("rejects when the owner has sent 100 invitation emails in the last 24 h", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 100; i++) {
        await seedInvitationEmailEvent(ctx, {
          invitedByUserId: owner._id,
          circleId,
          emailLower: `cap-${i}@example.com`,
          kind: "create",
          sentAt: now - 1000,
        });
      }
    });

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "one-more@example.com" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteDailyCapReached),
    });
  });

  it("fires the daily cap even when the sender has many lifetime invitation events outside the window", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 150; i++) {
        await seedInvitationEmailEvent(ctx, {
          invitedByUserId: owner._id,
          circleId,
          emailLower: `old-${i}@example.com`,
          kind: "create",
          sentAt: now - INVITE_TTL_MS,
        });
      }
      for (let i = 0; i < 100; i++) {
        await seedInvitationEmailEvent(ctx, {
          invitedByUserId: owner._id,
          circleId,
          emailLower: `recent-${i}@example.com`,
          kind: "create",
          sentAt: now - 1000,
        });
      }
    });

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "one-more@example.com" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteDailyCapReached),
    });
  });

  it("counts email events (creates and resends), not invitation rows", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const now = Date.now();
    await t.run(async (ctx) => {
      await seedInvitationEmailEvent(ctx, {
        invitedByUserId: owner._id,
        circleId,
        emailLower: "ada@example.com",
        kind: "create",
        sentAt: now - 4000,
      });
      for (let i = 0; i < 3; i++) {
        await seedInvitationEmailEvent(ctx, {
          invitedByUserId: owner._id,
          circleId,
          emailLower: "ada@example.com",
          kind: "resend",
          sentAt: now - 3000 + i,
        });
      }
      for (let i = 0; i < 96; i++) {
        await seedInvitationEmailEvent(ctx, {
          invitedByUserId: owner._id,
          circleId,
          emailLower: `other-${i}@example.com`,
          kind: "create",
          sentAt: now - 1000,
        });
      }
    });

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "one-more@example.com" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteDailyCapReached),
    });
  });
});

describe("createInvitation — per-address create cap", () => {
  it("rejects a third create to the same email within 24 h", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 2; i++) {
        await seedInvitationEmailEvent(ctx, {
          invitedByUserId: owner._id,
          circleId,
          emailLower: "a@x.com",
          kind: "create",
          sentAt: now - 1000 - i,
        });
      }
    });

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "a@x.com" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteAddressCapReached),
    });
  });
});

describe("listPendingInvitations", () => {
  it("returns pending non-expired invitations for the Owner without tokenHash", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, { email: "ada@example.com" }),
    );

    const result = await t.query(api.invitations.listPendingInvitations, { circleId });
    expect(result).toHaveLength(1);
    expect(result?.[0]).toEqual({
      id: inviteId,
      email: "ada@example.com",
      createdAt: expect.any(Number),
      expiresAt: expect.any(Number),
      resendCount: 0,
    });
    expect(result?.[0]).not.toHaveProperty("tokenHash");
  });

  it("returns null for a non-owner Member", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const member = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya"));
    await t.run((ctx) => seedInvitation(ctx, circleId, owner._id, { email: "ada@example.com" }));
    mockCurrentUser.mockResolvedValue(member.user);

    expect(await t.query(api.invitations.listPendingInvitations, { circleId })).toBeNull();
  });

  it("returns null for a non-member", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const stranger = await t.run((ctx) => makeUser(ctx, "stranger@example.com", "Stranger"));
    await t.run((ctx) => seedInvitation(ctx, circleId, owner._id, { email: "ada@example.com" }));
    mockCurrentUser.mockResolvedValue(stranger);

    expect(await t.query(api.invitations.listPendingInvitations, { circleId })).toBeNull();
  });

  it("returns null when unauthenticated", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    await t.run((ctx) => seedInvitation(ctx, circleId, owner._id, { email: "ada@example.com" }));
    mockCurrentUser.mockResolvedValue(null);

    expect(await t.query(api.invitations.listPendingInvitations, { circleId })).toBeNull();
  });

  it("excludes expired, revoked, and accepted invitations", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const now = Date.now();
    await t.run(async (ctx) => {
      await seedInvitation(ctx, circleId, owner._id, {
        email: "expired@example.com",
        expiresAt: now - 1,
      });
      await seedInvitation(ctx, circleId, owner._id, {
        email: "revoked@example.com",
        status: "revoked",
      });
      await seedInvitation(ctx, circleId, owner._id, {
        email: "accepted@example.com",
        status: "accepted",
      });
      await seedInvitation(ctx, circleId, owner._id, { email: "pending@example.com" });
    });

    const result = await t.query(api.invitations.listPendingInvitations, { circleId });
    expect(result).toHaveLength(1);
    expect(result?.[0]?.email).toBe("pending@example.com");
  });

  it("returns all pending invitations when multiple exist", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    await t.run(async (ctx) => {
      for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
        await seedInvitation(ctx, circleId, owner._id, { email });
      }
    });

    expect(await t.query(api.invitations.listPendingInvitations, { circleId })).toHaveLength(3);
  });
});

describe("resendInvitation", () => {
  it("rotates the token, refreshes expiry, and records history", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const oldToken = "old-plaintext-token";
    const oldHash = await hashInvitationToken(oldToken);
    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, {
        email: "ada@example.com",
        tokenHash: oldHash,
        expiresAt: Date.now() + 1000,
      }),
    );

    const before = Date.now();
    await t.mutation(api.invitations.resendInvitation, { invitationId: inviteId });

    await t.run(async (ctx) => {
      const invite = await ctx.db.get(inviteId);
      expect(invite?.tokenHash).not.toBe(oldHash);
      expect(invite?.resendCount).toBe(1);
      expect(invite?.resendTimestamps).toHaveLength(1);
      expect(invite?.expiresAt).toBeGreaterThanOrEqual(before + INVITE_TTL_MS - 1000);

      const events = await listEntityHistory(ctx, circleEntity(circleId));
      expect(events.some((event) => event.action === "invitation resent")).toBe(true);
      const resent = events.find((event) => event.action === "invitation resent");
      expect(resent?.changes).toEqual([{ field: "email", to: "ada@example.com" }]);
    });
  });

  it("enqueues and sends exactly one resend email with a rotated token", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("RESEND_FROM_EMAIL", "no-reply@pocketcircle.test");
    vi.stubEnv("SITE_URL", "https://app.example.com");

    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);
    vi.useFakeTimers();
    try {
      await drainWorkpool(t);
    } finally {
      vi.useRealTimers();
    }

    const initialToken = "old-plaintext-token";
    const initialTokenHash = await hashInvitationToken(initialToken);
    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, {
        email: "ada@example.com",
        tokenHash: initialTokenHash,
      }),
    );

    resetCapturedRequests();
    vi.useFakeTimers();
    try {
      await t.mutation(api.invitations.resendInvitation, { invitationId: inviteId });
      await drainWorkpool(t);
    } finally {
      vi.useRealTimers();
    }

    const resend = capturedRequests.filter(
      (r) => r.vendor === "resend" && r.headers?.["idempotency-key"] === `invite:${inviteId}:1`,
    );
    expect(resend.length).toBeGreaterThanOrEqual(1);
    const resendCall = resend.at(-1);
    expect(resendCall?.body).toMatchObject({ to: "ada@example.com" });
    const resentToken = inviteTokenFromHtml(resendBodyHtml(resendCall?.body));
    expect(resentToken).not.toBe(initialToken);
  });

  it("uses distinct idempotency keys for create and resend sends", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("RESEND_FROM_EMAIL", "no-reply@pocketcircle.test");

    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    resetCapturedRequests();
    await inviteAndDrain(t, { circleId, email: "ada@example.com" });

    const inviteId = await t.run(async (ctx) => {
      const invite = await ctx.db
        .query("invitations")
        .withIndex("by_circle_and_email", (q) =>
          q.eq("circleId", circleId).eq("emailLower", "ada@example.com"),
        )
        .unique();
      if (!invite) {
        throw new Error("expected invitation row");
      }
      return invite._id;
    });

    vi.useFakeTimers();
    try {
      await t.mutation(api.invitations.resendInvitation, { invitationId: inviteId });
      await drainWorkpool(t);
    } finally {
      vi.useRealTimers();
    }

    const resend = capturedRequests.filter((r) => r.vendor === "resend");
    expect(resend).toHaveLength(2);
    expect(resend[0]?.headers?.["idempotency-key"]).toBe(`invite:${inviteId}:0`);
    expect(resend[1]?.headers?.["idempotency-key"]).toBe(`invite:${inviteId}:1`);
    expect(resend[0]?.headers?.["idempotency-key"]).not.toBe(
      resend[1]?.headers?.["idempotency-key"],
    );
  });

  it("no-ops superseded resend jobs queued before the workpool drains", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("RESEND_FROM_EMAIL", "no-reply@pocketcircle.test");
    vi.stubEnv("SITE_URL", "https://app.example.com");

    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);
    vi.useFakeTimers();
    try {
      await drainWorkpool(t);
    } finally {
      vi.useRealTimers();
    }

    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, { email: "ada@example.com" }),
    );

    resetCapturedRequests();
    vi.useFakeTimers();
    try {
      await t.mutation(api.invitations.resendInvitation, { invitationId: inviteId });
      await t.mutation(api.invitations.resendInvitation, { invitationId: inviteId });
      await drainWorkpool(t);
    } finally {
      vi.useRealTimers();
    }

    const resend = capturedRequests.filter((r) => r.vendor === "resend");
    expect(resend).toHaveLength(1);
    expect(resend[0]?.headers?.["idempotency-key"]).toBe(`invite:${inviteId}:2`);
    expect(resend[0]?.body).toMatchObject({ to: "ada@example.com" });

    const sentToken = inviteTokenFromHtml(resendBodyHtml(resend[0]?.body));
    await t.run(async (ctx) => {
      const invite = await ctx.db.get(inviteId);
      if (!invite) {
        throw new Error("expected invitation row");
      }
      expect(await hashInvitationToken(sentToken)).toBe(invite.tokenHash);
    });
  });

  it("rejects an archived Circle", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx, { archived: true }));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, { email: "ada@example.com" }),
    );

    await expect(
      t.mutation(api.invitations.resendInvitation, { invitationId: inviteId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleArchived),
    });
  });

  it("rejects a non-owner Member", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const member = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya"));
    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, { email: "ada@example.com" }),
    );
    mockCurrentUser.mockResolvedValue(member.user);

    await expect(
      t.mutation(api.invitations.resendInvitation, { invitationId: inviteId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteForbidden),
    });
  });

  it("rejects a non-member with a generic error", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const stranger = await t.run((ctx) => makeUser(ctx, "stranger@example.com", "Stranger"));
    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, { email: "ada@example.com" }),
    );
    mockCurrentUser.mockResolvedValue(stranger);

    await expect(
      t.mutation(api.invitations.resendInvitation, { invitationId: inviteId }),
    ).rejects.toThrow("Circle not found");
  });

  it("rejects an invitation from a different Circle", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    const { circleId: otherCircleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    await t.run((ctx) => markCircleSetupComplete(ctx, otherCircleId));
    mockCurrentUser.mockResolvedValue(owner);

    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, otherCircleId, owner._id, { email: "ada@example.com" }),
    );

    await expect(
      t.mutation(api.invitations.resendInvitation, { invitationId: inviteId }),
    ).rejects.toThrow("Circle not found");
  });

  it("rejects revoked and expired invitations with a generic error", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const revokedId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, {
        email: "revoked@example.com",
        status: "revoked",
      }),
    );
    const expiredId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, {
        email: "expired@example.com",
        expiresAt: Date.now() - 1,
      }),
    );

    for (const invitationId of [revokedId, expiredId]) {
      await expect(
        t.mutation(api.invitations.resendInvitation, { invitationId }),
      ).rejects.toMatchObject({
        data: mutationErrorData(MUTATION_ERRORS.inviteInvalid),
      });
    }
  });

  it("rejects setup-incomplete Circles", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, { email: "ada@example.com" }),
    );

    await expect(
      t.mutation(api.invitations.resendInvitation, { invitationId: inviteId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleSetupIncomplete),
    });
  });

  it("enforces the per-email resend cap within 24 h", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const now = Date.now();
    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, {
        email: "ada@example.com",
      }),
    );
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await seedInvitationEmailEvent(ctx, {
          invitedByUserId: owner._id,
          circleId,
          emailLower: "ada@example.com",
          kind: "resend",
          sentAt: now - 1000 - i,
        });
      }
    });

    await expect(
      t.mutation(api.invitations.resendInvitation, { invitationId: inviteId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteResendCapReached),
    });
  });

  it("resend cap survives revoke and recreate for the same email", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await seedInvitationEmailEvent(ctx, {
          invitedByUserId: owner._id,
          circleId,
          emailLower: "a@x.com",
          kind: "resend",
          sentAt: now - 1000 - i,
        });
      }
    });
    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, {
        email: "a@x.com",
      }),
    );

    await expect(
      t.mutation(api.invitations.resendInvitation, { invitationId: inviteId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteResendCapReached),
    });
  });

  it("allows resend when prior timestamps are outside the 24 h window", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const now = Date.now();
    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, {
        email: "ada@example.com",
      }),
    );
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await seedInvitationEmailEvent(ctx, {
          invitedByUserId: owner._id,
          circleId,
          emailLower: "ada@example.com",
          kind: "resend",
          sentAt: now - INVITE_TTL_MS - i,
        });
      }
    });

    await t.mutation(api.invitations.resendInvitation, { invitationId: inviteId });
  });

  it("counts only in-window resend events toward the cap", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const now = Date.now();
    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, {
        email: "ada@example.com",
      }),
    );
    await t.run(async (ctx) => {
      await seedInvitationEmailEvent(ctx, {
        invitedByUserId: owner._id,
        circleId,
        emailLower: "ada@example.com",
        kind: "resend",
        sentAt: now - 1000,
      });
      await seedInvitationEmailEvent(ctx, {
        invitedByUserId: owner._id,
        circleId,
        emailLower: "ada@example.com",
        kind: "resend",
        sentAt: now - 2000,
      });
      await seedInvitationEmailEvent(ctx, {
        invitedByUserId: owner._id,
        circleId,
        emailLower: "ada@example.com",
        kind: "resend",
        sentAt: now - INVITE_TTL_MS,
      });
    });

    await t.mutation(api.invitations.resendInvitation, { invitationId: inviteId });
  });

  it("increments resendCount across multiple resends", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, { email: "ada@example.com" }),
    );

    await t.mutation(api.invitations.resendInvitation, { invitationId: inviteId });
    await t.mutation(api.invitations.resendInvitation, { invitationId: inviteId });

    await t.run(async (ctx) => {
      const invite = await ctx.db.get(inviteId);
      expect(invite?.resendCount).toBe(2);
    });
  });

  it("enforces the daily user cap on resend", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 100; i++) {
        await seedInvitationEmailEvent(ctx, {
          invitedByUserId: owner._id,
          circleId,
          emailLower: `daily-${i}@example.com`,
          kind: "create",
          sentAt: now - 1000,
        });
      }
    });

    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, {
        email: "target@example.com",
        createdAt: now - INVITE_TTL_MS,
      }),
    );

    await expect(
      t.mutation(api.invitations.resendInvitation, { invitationId: inviteId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteDailyCapReached),
    });
  });

  it("allows resend when 99 emails are in-window and one is outside", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 99; i++) {
        await seedInvitationEmailEvent(ctx, {
          invitedByUserId: owner._id,
          circleId,
          emailLower: `daily-${i}@example.com`,
          kind: "create",
          sentAt: now - 1000,
        });
      }
      await seedInvitationEmailEvent(ctx, {
        invitedByUserId: owner._id,
        circleId,
        emailLower: "old@example.com",
        kind: "create",
        sentAt: now - INVITE_TTL_MS,
      });
    });

    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, {
        email: "target@example.com",
        createdAt: now - INVITE_TTL_MS,
      }),
    );

    await t.mutation(api.invitations.resendInvitation, { invitationId: inviteId });
  });
});

describe("revokeInvitation", () => {
  it("sets status to revoked and records history", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const ada = await t.run((ctx) => makeUser(ctx, "ada@example.com", "Ada Lovelace"));

    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, { email: ada.email }),
    );

    await mutateAndDrain(t, () =>
      t.mutation(api.invitations.revokeInvitation, { invitationId: inviteId }),
    );

    await t.run(async (ctx) => {
      const invite = await ctx.db.get(inviteId);
      expect(invite?.status).toBe("revoked");

      const events = await listEntityHistory(ctx, circleEntity(circleId));
      const revoked = events.find((event) => event.action === "invitation revoked");
      expect(revoked?.changes).toEqual([{ field: "email", from: "ada@example.com" }]);

      const notifications = await listNotificationsForUser(ctx, ada._id);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.type).toBe("invitation.revoked");
    });
  });

  it("revokes a pending Invitation on an incomplete regular Circle", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, { email: "pending@example.com" }),
    );

    await t.mutation(api.invitations.revokeInvitation, { invitationId: inviteId });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(circleId))?.setupCompletedAt).toBeNull();
      expect((await ctx.db.get(inviteId))?.status).toBe("revoked");
    });
  });

  it("rejects an archived Circle", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx, { archived: true }));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, { email: "ada@example.com" }),
    );

    await expect(
      t.mutation(api.invitations.revokeInvitation, { invitationId: inviteId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleArchived),
    });
  });

  it("rejects a non-owner Member", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const member = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya"));
    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, { email: "ada@example.com" }),
    );
    mockCurrentUser.mockResolvedValue(member.user);

    await expect(
      t.mutation(api.invitations.revokeInvitation, { invitationId: inviteId }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteForbidden),
    });
  });

  it("rejects a non-member with a generic error", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const stranger = await t.run((ctx) => makeUser(ctx, "stranger@example.com", "Stranger"));
    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, { email: "ada@example.com" }),
    );
    mockCurrentUser.mockResolvedValue(stranger);

    await expect(
      t.mutation(api.invitations.revokeInvitation, { invitationId: inviteId }),
    ).rejects.toThrow("Circle not found");
  });

  it("rejects already-revoked and accepted invitations", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    mockCurrentUser.mockResolvedValue(owner);

    const revokedId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, {
        email: "revoked@example.com",
        status: "revoked",
      }),
    );
    const acceptedId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, {
        email: "accepted@example.com",
        status: "accepted",
      }),
    );

    for (const invitationId of [revokedId, acceptedId]) {
      await expect(
        t.mutation(api.invitations.revokeInvitation, { invitationId }),
      ).rejects.toMatchObject({
        data: mutationErrorData(MUTATION_ERRORS.inviteInvalid),
      });
    }
  });

  it("rejects an invitation from a different Circle", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    const { circleId: otherCircleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    await t.run((ctx) => markCircleSetupComplete(ctx, otherCircleId));
    mockCurrentUser.mockResolvedValue(owner);

    const inviteId = await t.run((ctx) =>
      seedInvitation(ctx, otherCircleId, owner._id, { email: "ada@example.com" }),
    );

    await expect(
      t.mutation(api.invitations.revokeInvitation, { invitationId: inviteId }),
    ).rejects.toThrow("Circle not found");
  });
});

describe("getInvitationPreview", () => {
  it("returns the four preview fields for a pending, unexpired invitation", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const token = await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId,
        email: "ada@example.com",
        invitedByUserId: owner._id,
      }),
    );

    const preview = await t.query(api.invitations.getInvitationPreview, { token });
    expect(preview).toEqual({
      circleName: "Trip",
      ownerDisplayName: "Olive Owner",
      ownerImage: null,
      invitedEmail: "ada@example.com",
    });
    expect(Object.keys(preview ?? {}).sort()).toEqual(
      ["circleName", "invitedEmail", "ownerDisplayName", "ownerImage"].sort(),
    );
  });

  it("returns null for a missing token", async () => {
    const t = createTestConvex();
    expect(await t.query(api.invitations.getInvitationPreview, { token: "missing" })).toBeNull();
  });

  it("returns null for an expired invitation", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const token = await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId,
        email: "ada@example.com",
        invitedByUserId: owner._id,
        expiresAt: Date.now() - 1,
      }),
    );
    expect(await t.query(api.invitations.getInvitationPreview, { token })).toBeNull();
  });

  it.each([
    "accepted",
    "revoked",
  ] as const)("returns null when the invitation is %s", async (status) => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const token = await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId,
        email: "ada@example.com",
        invitedByUserId: owner._id,
        status,
      }),
    );
    expect(await t.query(api.invitations.getInvitationPreview, { token })).toBeNull();
  });

  it("returns null for an incomplete Circle", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    const token = await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId,
        email: "ada@example.com",
        invitedByUserId: owner._id,
      }),
    );
    expect(await t.query(api.invitations.getInvitationPreview, { token })).toBeNull();
  });

  it("returns null for an archived Circle", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const token = await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId,
        email: "ada@example.com",
        invitedByUserId: owner._id,
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(circleId, { status: "archived" });
    });
    expect(await t.query(api.invitations.getInvitationPreview, { token })).toBeNull();
  });
});

describe("acceptInvitation — happy path", () => {
  it("inserts an active member, marks the invitation accepted, and records history", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const ada = await t.run((ctx) => makeUser(ctx, "ada@example.com", "Ada Lovelace"));
    const token = await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId,
        email: ada.email,
        invitedByUserId: owner._id,
      }),
    );
    mockCurrentUser.mockResolvedValue(ada);

    const { circleId: returnedCircleId } = await mutateAndDrain(t, () =>
      t.mutation(api.invitations.acceptInvitation, { token }),
    );
    expect(returnedCircleId).toBe(circleId);

    await t.run(async (ctx) => {
      const tokenHash = await hashInvitationToken(token);
      const invite = await ctx.db
        .query("invitations")
        .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
        .unique();
      expect(invite?.status).toBe("accepted");

      const membership = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) => q.eq("circleId", circleId).eq("userId", ada._id))
        .unique();
      expect(membership?.status).toBe("active");
      expect(membership?.displayName).toBe("Ada Lovelace");

      const events = await listEntityHistory(ctx, circleEntity(circleId));
      const joined = events.find((event) => event.action === "member joined");
      expect(joined?.changes).toEqual([{ field: "member", to: "Ada Lovelace" }]);
      expect(JSON.stringify(joined?.changes)).not.toMatch(/[a-z0-9]{20,}/i);

      const notifications = await listNotificationsForUser(ctx, owner._id);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.type).toBe("invitation.accepted");
    });

    mockCurrentUser.mockResolvedValue(ada);
    await expect(t.mutation(api.invitations.acceptInvitation, { token })).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteInvalid),
    });
  });
});

describe("acceptInvitation — rejoin", () => {
  it("reactivates the same member row and preserves transaction references", async () => {
    const t = createTestConvex();
    const fixture = await t.run((ctx) => seedFixture(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, fixture.circleId));
    const removed = await t.run((ctx) =>
      addMember(ctx, fixture.circleId, "ada@example.com", "Ada Lovelace", "removed"),
    );
    const originalJoinedAt = await t.run(async (ctx) => {
      const row = await ctx.db.get(removed.memberId);
      return row?.joinedAt;
    });
    await t.run(async (ctx) => {
      await seedTransaction(ctx, fixture, {
        recordedByMemberId: removed.memberId,
        paidByMemberId: removed.memberId,
        title: "Ada expense",
      });
    });
    const token = await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId: fixture.circleId,
        email: removed.user.email,
        invitedByUserId: fixture.owner._id,
      }),
    );
    mockCurrentUser.mockResolvedValue(removed.user);

    await t.mutation(api.invitations.acceptInvitation, { token });

    await t.run(async (ctx) => {
      const membership = await ctx.db.get(removed.memberId);
      expect(membership?.status).toBe("active");
      expect(membership?.joinedAt).toBe(originalJoinedAt);
      expect(membership?.displayName).toBe("Ada Lovelace");
      expect(membership?.removedAt).toBeUndefined();

      const txn = await ctx.db
        .query("transactions")
        .withIndex("by_circle", (q) => q.eq("circleId", fixture.circleId))
        .first();
      expect(txn?.recordedByMemberId).toBe(removed.memberId);
      expect(txn?.paidByMemberId).toBe(removed.memberId);
    });
  });
});

describe("acceptInvitation — failures", () => {
  it("rejects an unauthenticated caller before token validation", async () => {
    const t = createTestConvex();
    mockCurrentUser.mockResolvedValue(null);

    await expect(
      t.mutation(api.invitations.acceptInvitation, { token: "any-token" }),
    ).rejects.toThrow("Not authenticated");
  });

  it.each([
    "missing-token",
    "wrong-email",
    "expired",
    "accepted",
    "revoked",
    "incomplete-circle",
  ] as const)("returns the generic invalid signal for %s with no writes", async (caseName) => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    const ada = await t.run((ctx) => makeUser(ctx, "ada@example.com", "Ada"));
    const wrong = await t.run((ctx) => makeUser(ctx, "wrong@example.com", "Wrong"));
    let token = "missing-token";

    await t.run(async (ctx) => {
      if (caseName === "incomplete-circle") {
        token = await seedPendingInvitation(ctx, {
          circleId,
          email: ada.email,
          invitedByUserId: owner._id,
        });
        return;
      }
      await markCircleSetupComplete(ctx, circleId);
      if (caseName === "wrong-email") {
        token = await seedPendingInvitation(ctx, {
          circleId,
          email: ada.email,
          invitedByUserId: owner._id,
        });
        return;
      }
      if (caseName === "expired") {
        token = await seedPendingInvitation(ctx, {
          circleId,
          email: ada.email,
          invitedByUserId: owner._id,
          expiresAt: Date.now() - 1,
        });
        return;
      }
      if (caseName === "accepted") {
        token = await seedPendingInvitation(ctx, {
          circleId,
          email: ada.email,
          invitedByUserId: owner._id,
          status: "accepted",
        });
        return;
      }
      if (caseName === "revoked") {
        token = await seedPendingInvitation(ctx, {
          circleId,
          email: ada.email,
          invitedByUserId: owner._id,
          status: "revoked",
        });
      }
    });

    mockCurrentUser.mockResolvedValue(caseName === "wrong-email" ? wrong : ada);

    await expect(t.mutation(api.invitations.acceptInvitation, { token })).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteInvalid),
    });

    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) => q.eq("circleId", circleId).eq("userId", ada._id))
        .unique();
      expect(membership).toBeNull();

      if (caseName !== "missing-token" && caseName !== "incomplete-circle") {
        const tokenHash = await hashInvitationToken(token);
        const invite = await ctx.db
          .query("invitations")
          .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
          .unique();
        if (caseName === "accepted") {
          expect(invite?.status).toBe("accepted");
        } else if (caseName === "revoked") {
          expect(invite?.status).toBe("revoked");
        } else {
          expect(invite?.status).toBe("pending");
        }
      }
    });
  });

  it("rejects accept into an archived Circle with invite.invalid", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const ada = await t.run((ctx) => makeUser(ctx, "ada@example.com", "Ada"));
    const token = await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId,
        email: ada.email,
        invitedByUserId: owner._id,
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(circleId, { status: "archived" });
    });
    mockCurrentUser.mockResolvedValue(ada);

    await expect(t.mutation(api.invitations.acceptInvitation, { token })).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.inviteInvalid),
    });

    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) => q.eq("circleId", circleId).eq("userId", ada._id))
        .unique();
      expect(membership).toBeNull();
    });
  });

  it("allows exactly one member row when accept is attempted twice concurrently", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    const ada = await t.run((ctx) => makeUser(ctx, "ada@example.com", "Ada"));
    const token = await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId,
        email: ada.email,
        invitedByUserId: owner._id,
      }),
    );
    mockCurrentUser.mockResolvedValue(ada);

    const results = await Promise.allSettled([
      t.mutation(api.invitations.acceptInvitation, { token }),
      t.mutation(api.invitations.acceptInvitation, { token }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    await t.run(async (ctx) => {
      const memberships = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) => q.eq("circleId", circleId).eq("userId", ada._id))
        .collect();
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.status).toBe("active");
    });
  });
});

async function seedActiveMemberCount(
  ctx: MutationCtx,
  circleId: Id<"circles">,
  totalActive: number,
) {
  const active = await ctx.db
    .query("members")
    .withIndex("by_circle_and_status", (q) => q.eq("circleId", circleId).eq("status", "active"))
    .collect();
  const toAdd = totalActive - active.length;
  for (let i = 0; i < toAdd; i++) {
    const index = active.length + i;
    await addMember(ctx, circleId, `capacity-member-${index}@example.com`, `Member ${index}`);
  }
}

describe("circle capacity", () => {
  it("allows createInvitation when 255 seats are occupied", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    await t.run((ctx) => seedActiveMemberCount(ctx, circleId, 255));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "new@example.com" }),
    ).resolves.toBeNull();
  });

  it("rejects createInvitation when 256 seats are occupied", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    await t.run((ctx) => seedActiveMemberCount(ctx, circleId, 256));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "new@example.com" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleCapacityFull),
    });
  });

  it("rejects createInvitation when 255 active members and 1 pending invitation occupy all seats", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    await t.run((ctx) => seedActiveMemberCount(ctx, circleId, 255));
    await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId,
        email: "pending@example.com",
        invitedByUserId: owner._id,
      }),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "another@example.com" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleCapacityFull),
    });
  });

  it("allows acceptInvitation when 255 active members and a matching pending invite", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    await t.run((ctx) => seedActiveMemberCount(ctx, circleId, 255));
    const ada = await t.run((ctx) => makeUser(ctx, "ada@example.com", "Ada Lovelace"));
    const token = await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId,
        email: ada.email,
        invitedByUserId: owner._id,
      }),
    );
    mockCurrentUser.mockResolvedValue(ada);

    await expect(t.mutation(api.invitations.acceptInvitation, { token })).resolves.toMatchObject({
      circleId,
    });

    await t.run(async (ctx) => {
      const active = await ctx.db
        .query("members")
        .withIndex("by_circle_and_status", (q) => q.eq("circleId", circleId).eq("status", "active"))
        .collect();
      expect(active).toHaveLength(256);
    });
  });

  it("rejects acceptInvitation when the Circle already has 256 active members", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    await t.run((ctx) => seedActiveMemberCount(ctx, circleId, 256));
    const ada = await t.run((ctx) => makeUser(ctx, "ada@example.com", "Ada Lovelace"));
    const token = await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId,
        email: ada.email,
        invitedByUserId: owner._id,
      }),
    );
    mockCurrentUser.mockResolvedValue(ada);

    await expect(t.mutation(api.invitations.acceptInvitation, { token })).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleCapacityReached),
    });
  });

  it("rejects reactivation when the Circle already has 256 active members", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    await t.run((ctx) => seedActiveMemberCount(ctx, circleId, 255));
    const removed = await t.run((ctx) =>
      addMember(ctx, circleId, "ada@example.com", "Ada Lovelace", "removed"),
    );
    await t.run((ctx) => seedActiveMemberCount(ctx, circleId, 256));
    const token = await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId,
        email: removed.user.email,
        invitedByUserId: owner._id,
      }),
    );
    mockCurrentUser.mockResolvedValue(removed.user);

    await expect(t.mutation(api.invitations.acceptInvitation, { token })).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleCapacityReached),
    });

    await t.run(async (ctx) => {
      const membership = await ctx.db.get(removed.memberId);
      expect(membership?.status).toBe("removed");
    });
  });

  it("allows the 256th active member and rejects the 257th invitation", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    await t.run((ctx) => seedActiveMemberCount(ctx, circleId, CIRCLE_CAPACITY_LIMIT));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "overflow@example.com" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleCapacityFull),
    });

    await t.run(async (ctx) => {
      const active = await ctx.db
        .query("members")
        .withIndex("by_circle_and_status", (q) => q.eq("circleId", circleId).eq("status", "active"))
        .collect();
      expect(active).toHaveLength(CIRCLE_CAPACITY_LIMIT);
    });
  });

  it("allows only one concurrent accept into a 255-active Circle", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    await t.run((ctx) => seedActiveMemberCount(ctx, circleId, 255));
    const ada = await t.run((ctx) => makeUser(ctx, "ada@example.com", "Ada"));
    const bob = await t.run((ctx) => makeUser(ctx, "bob@example.com", "Bob"));
    const adaToken = await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId,
        email: ada.email,
        invitedByUserId: owner._id,
      }),
    );
    const bobToken = await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId,
        email: bob.email,
        invitedByUserId: owner._id,
      }),
    );

    mockCurrentUser.mockResolvedValueOnce(ada).mockResolvedValueOnce(bob);

    const results = await Promise.allSettled([
      t.mutation(api.invitations.acceptInvitation, { token: adaToken }),
      t.mutation(api.invitations.acceptInvitation, { token: bobToken }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleCapacityReached),
    });

    await t.run(async (ctx) => {
      const active = await ctx.db
        .query("members")
        .withIndex("by_circle_and_status", (q) => q.eq("circleId", circleId).eq("status", "active"))
        .collect();
      expect(active).toHaveLength(256);
    });
  });

  it("allows only one concurrent createInvitation when one seat remains", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    await t.run((ctx) => seedActiveMemberCount(ctx, circleId, 255));
    mockCurrentUser.mockResolvedValue(owner);

    const results = await Promise.allSettled([
      t.mutation(api.invitations.createInvitation, { circleId, email: "ada@example.com" }),
      t.mutation(api.invitations.createInvitation, { circleId, email: "bob@example.com" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleCapacityFull),
    });

    await t.run(async (ctx) => {
      const pending = await ctx.db
        .query("invitations")
        .withIndex("by_circle", (q) => q.eq("circleId", circleId))
        .collect();
      const unexpiredPending = pending.filter(
        (invite) => invite.status === "pending" && invite.expiresAt > Date.now(),
      );
      expect(unexpiredPending).toHaveLength(1);
    });
  });

  it("releases a revoked invitation seat for a new invite", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    await t.run((ctx) => seedActiveMemberCount(ctx, circleId, 255));
    const invitationId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, { email: "revoked@example.com" }),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "blocked@example.com" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleCapacityFull),
    });

    await t.mutation(api.invitations.revokeInvitation, { invitationId });

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "blocked@example.com" }),
    ).resolves.toBeNull();
  });

  it("releases an expired invitation seat for a new invite", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    await t.run((ctx) => seedActiveMemberCount(ctx, circleId, 255));
    await t.run((ctx) =>
      seedPendingInvitation(ctx, {
        circleId,
        email: "expired@example.com",
        invitedByUserId: owner._id,
        expiresAt: Date.now() - 1,
      }),
    );
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "new@example.com" }),
    ).resolves.toBeNull();
  });

  it("keeps exactly one reserved seat when resending a pending invitation", async () => {
    vi.useFakeTimers();
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("RESEND_FROM_EMAIL", "no-reply@pocketcircle.test");

    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await t.run((ctx) => markCircleSetupComplete(ctx, circleId));
    await t.run((ctx) => seedActiveMemberCount(ctx, circleId, 255));
    const invitationId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, { email: "pending@example.com" }),
    );
    mockCurrentUser.mockResolvedValue(owner);

    const occupiedBefore = await t.run(async (ctx) => {
      const active = await ctx.db
        .query("members")
        .withIndex("by_circle_and_status", (q) => q.eq("circleId", circleId).eq("status", "active"))
        .collect();
      const pending = await ctx.db
        .query("invitations")
        .withIndex("by_circle", (q) => q.eq("circleId", circleId))
        .collect();
      const now = Date.now();
      const unexpiredPending = pending.filter(
        (invite) => invite.status === "pending" && invite.expiresAt > now,
      );
      return active.length + unexpiredPending.length;
    });

    await t.mutation(api.invitations.resendInvitation, { invitationId });
    await drainWorkpool(t);

    const occupiedAfter = await t.run(async (ctx) => {
      const active = await ctx.db
        .query("members")
        .withIndex("by_circle_and_status", (q) => q.eq("circleId", circleId).eq("status", "active"))
        .collect();
      const pending = await ctx.db
        .query("invitations")
        .withIndex("by_circle", (q) => q.eq("circleId", circleId))
        .collect();
      const now = Date.now();
      const unexpiredPending = pending.filter(
        (invite) => invite.status === "pending" && invite.expiresAt > now,
      );
      return active.length + unexpiredPending.length;
    });

    expect(occupiedBefore).toBe(256);
    expect(occupiedAfter).toBe(256);

    await expect(
      t.mutation(api.invitations.createInvitation, { circleId, email: "another@example.com" }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.circleCapacityFull),
    });

    vi.useRealTimers();
  });
});
