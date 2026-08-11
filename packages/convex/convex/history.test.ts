import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import type { MutationCtx } from "./_generated/server.js";
import { circleEntity, listEntityHistory, recordEvent } from "./history.js";
import schema from "./schema.js";

// Exercises the history module directly through the db helper — the audit is
// written server-side only (ADR 0015), so the module is its own test surface
// without going through the auth-gated api functions.
const modules = import.meta.glob("./**/*.ts");

/** Seeds a Circle and an owner Member, returning both ids. */
async function seedCircleWithOwner(ctx: MutationCtx) {
  const now = Date.now();
  const userId = await ctx.db.insert("users", {
    email: "ada@example.com",
    displayName: "Ada Lovelace",
    acceptedTermsVersion: "2026-05-01",
    acceptedPrivacyVersion: "2026-05-01",
    acceptedAt: now,
    analyticsEnabled: false,
    onboardingCompletedAt: now,
    createdAt: now,
  });
  const circleId = await ctx.db.insert("circles", {
    name: "Personal",
    kind: "personal",
    currency: "USD",
    color: "blue",
    mark: "P",
    ownerUserId: userId,
    status: "active",
    setupCompletedAt: now,
    currencyLocked: false,
    accountDeletionBlocked: false,
    createdAt: now,
  });
  const memberId = await ctx.db.insert("members", {
    circleId,
    userId,
    role: "owner",
    status: "active",
    displayName: "Ada Lovelace",
    joinedAt: now,
  });
  const member = await ctx.db.get(memberId);
  if (!member) {
    throw new Error("seed failed");
  }
  return { circleId, member, ownerUserId: userId };
}

describe("recordEvent", () => {
  it("appends an immutable event row with the actor and frozen change text", async () => {
    const t = convexTest(schema, modules);

    const { circleId, member } = await t.run((ctx) => seedCircleWithOwner(ctx));

    await t.run((ctx) =>
      recordEvent(ctx, {
        entity: circleEntity(circleId),
        actor: member,
        action: "renamed",
        changes: [{ field: "name", from: "Personal", to: "Household" }],
      }),
    );

    await t.run(async (ctx) => {
      const rows = await ctx.db.query("histories").collect();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.entityId).toBe(circleId);
      expect(row?.actorMemberId).toBe(member._id);
      expect(row?.action).toBe("renamed");
      expect(row?.changes).toEqual([{ field: "name", from: "Personal", to: "Household" }]);
    });
  });

  it("records a system action with no actor", async () => {
    const t = convexTest(schema, modules);
    const { circleId } = await t.run((ctx) => seedCircleWithOwner(ctx));

    await t.run((ctx) =>
      recordEvent(ctx, {
        entity: circleEntity(circleId),
        actor: null,
        action: "created",
        changes: [{ field: "name", to: "Personal" }],
      }),
    );

    await t.run(async (ctx) => {
      const row = await ctx.db.query("histories").first();
      expect(row?.actorMemberId).toBeUndefined();
      expect(row?.changes[0]?.from).toBeUndefined();
    });
  });
});

describe("listEntityHistory", () => {
  it("returns an entity's events newest-first and excludes other entities", async () => {
    const t = convexTest(schema, modules);
    const { circleId, member, otherCircleId } = await t.run(async (ctx) => {
      const seeded = await seedCircleWithOwner(ctx);
      const other = await ctx.db.insert("circles", {
        name: "Other",
        kind: "regular",
        currency: "USD",
        color: "blue",
        mark: "O",
        ownerUserId: seeded.ownerUserId,
        status: "active",
        setupCompletedAt: null,
        currencyLocked: false,
        accountDeletionBlocked: false,
        createdAt: Date.now(),
      });
      return { ...seeded, otherCircleId: other };
    });

    await t.run(async (ctx) => {
      await recordEvent(ctx, {
        entity: circleEntity(circleId),
        actor: member,
        action: "created",
        changes: [{ field: "name", to: "Personal" }],
      });
      await recordEvent(ctx, {
        entity: circleEntity(circleId),
        actor: member,
        action: "renamed",
        changes: [{ field: "name", from: "Personal", to: "Household" }],
      });
      // An event on a different entity must not appear in this entity's history.
      await recordEvent(ctx, {
        entity: circleEntity(otherCircleId),
        actor: member,
        action: "created",
        changes: [{ field: "name", to: "Other" }],
      });
    });

    const events = await t.run((ctx) => listEntityHistory(ctx, circleEntity(circleId)));
    expect(events).toHaveLength(2);
    expect(events[0]?.action).toBe("renamed"); // newest first
    expect(events[1]?.action).toBe("created");
  });
});
