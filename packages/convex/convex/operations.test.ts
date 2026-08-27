import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockCurrentUser, signInAs } from "../test/mockAuth.js";
import { seedOwnedCircle, seedPersonalCircleOwner } from "../test/seed.js";
import { api } from "./_generated/api.js";
import {
  getCircleForUser,
  listMyCirclesForUser,
  resolveUserById,
  toCurrentUserView,
} from "./operations.js";
import schema from "./schema.js";

vi.mock("./auth.js", async () => (await import("../test/mockAuth.js")).authMockModule());

const modules = import.meta.glob("./**/*.ts");

type TestCtx = ReturnType<typeof convexTest>;

beforeEach(() => {
  resetMockCurrentUser();
});

/** Two onboarded Users; Grace is an active Member of Ada's shared regular Circle. */
async function seedOverlappingUsers(t: TestCtx) {
  const ada = await t.run((ctx) =>
    seedPersonalCircleOwner(ctx, {
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      onboarded: true,
    }),
  );
  const grace = await t.run((ctx) =>
    seedPersonalCircleOwner(ctx, {
      email: "grace@example.com",
      displayName: "Grace Hopper",
      onboarded: true,
    }),
  );
  const sharedId = await t.run(async (ctx) => {
    const owned = await seedOwnedCircle(ctx, ada.owner, {
      name: "Shared Trip",
      setupCompletedAt: Date.now(),
      createdAt: Date.now() + 1,
    });
    await ctx.db.insert("members", {
      circleId: owned.circleId,
      userId: grace.owner._id,
      role: "member",
      status: "active",
      displayName: grace.owner.displayName,
      joinedAt: Date.now(),
    });
    return owned.circleId;
  });
  return { ada, grace, sharedId };
}

describe("resolveUserById", () => {
  it("loads by stable PocketCircle id and rejects malformed ids", async () => {
    const t = convexTest(schema, modules);
    const { userId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );

    await t.run(async (ctx) => {
      const loaded = await resolveUserById(ctx, userId);
      expect(loaded?._id).toBe(userId);
      expect(loaded?.email).toBe("ada@example.com");
      expect(await resolveUserById(ctx, String(userId))).toEqual(loaded);
      expect(await resolveUserById(ctx, "not-a-user-id")).toBeNull();
    });
  });

  it("never resolves by email — an email string is not a User id", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );

    await t.run(async (ctx) => {
      expect(await resolveUserById(ctx, "ada@example.com")).toBeNull();
    });
  });
});

describe("current-User operation — browser vs explicit User", () => {
  it("returns the same view for the same User and different views for different Users", async () => {
    const t = convexTest(schema, modules);
    const { ada, grace } = await seedOverlappingUsers(t);

    const adaExplicit = toCurrentUserView(ada.owner);
    signInAs(ada.owner);
    const adaBrowser = await t.query(api.users.getCurrentUser, {});
    expect(adaBrowser).toEqual(adaExplicit);

    const graceExplicit = toCurrentUserView(grace.owner);
    signInAs(grace.owner);
    const graceBrowser = await t.query(api.users.getCurrentUser, {});
    expect(graceBrowser).toEqual(graceExplicit);
    expect(graceBrowser).not.toEqual(adaBrowser);
    expect(graceBrowser?.displayName).toBe("Grace Hopper");
  });

  it("returns null on the browser path when there is no session", async () => {
    const t = convexTest(schema, modules);
    signInAs(null);
    expect(await t.query(api.users.getCurrentUser, {})).toBeNull();
  });
});

describe("Circle-list operation — browser vs explicit User", () => {
  it("browser and explicit-User paths return the same authorized Circles for the same User", async () => {
    const t = convexTest(schema, modules);
    const { ada, grace, sharedId } = await seedOverlappingUsers(t);
    const archivedId = (
      await t.run((ctx) =>
        seedOwnedCircle(ctx, ada.owner, {
          name: "Old Trip",
          archived: true,
          setupCompletedAt: Date.now(),
          createdAt: Date.now() + 2,
        }),
      )
    ).circleId;

    await t.run(async (ctx) => {
      const adaExplicit = await listMyCirclesForUser(ctx, ada.owner);
      expect(adaExplicit.map((c) => c.id)).toEqual([ada.personalCircleId, sharedId, archivedId]);
      expect(adaExplicit[0]?.kind).toBe("personal");
      expect(adaExplicit.find((c) => c.id === archivedId)?.status).toBe("archived");

      const graceExplicit = await listMyCirclesForUser(ctx, grace.owner);
      expect(graceExplicit.map((c) => c.id)).toEqual([grace.personalCircleId, sharedId]);
      expect(graceExplicit.map((c) => c.id)).not.toEqual(adaExplicit.map((c) => c.id));
    });

    signInAs(ada.owner);
    const adaBrowser = await t.query(api.circles.listMyCircles, {});
    await t.run(async (ctx) => {
      expect(adaBrowser).toEqual(await listMyCirclesForUser(ctx, ada.owner));
    });

    signInAs(grace.owner);
    const graceBrowser = await t.query(api.circles.listMyCircles, {});
    await t.run(async (ctx) => {
      expect(graceBrowser).toEqual(await listMyCirclesForUser(ctx, grace.owner));
    });
    expect(graceBrowser).not.toEqual(adaBrowser);
  });

  it("excludes removed memberships and omits missing Circles", async () => {
    const t = convexTest(schema, modules);
    const { owner, personalCircleId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );

    await t.run(async (ctx) => {
      const left = await seedOwnedCircle(ctx, owner, {
        name: "Left Trip",
        setupCompletedAt: Date.now(),
      });
      const leftMembership = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", left.circleId).eq("userId", owner._id),
        )
        .unique();
      expect(leftMembership).toBeTruthy();
      if (!leftMembership) {
        return;
      }
      await ctx.db.patch(leftMembership._id, { status: "removed", removedAt: Date.now() });

      const orphan = await seedOwnedCircle(ctx, owner, {
        name: "Gone",
        setupCompletedAt: Date.now(),
      });
      await ctx.db.delete(orphan.circleId);

      const listed = await listMyCirclesForUser(ctx, owner);
      expect(listed.map((c) => c.id)).toEqual([personalCircleId]);
      expect(listed.some((c) => c.id === left.circleId)).toBe(false);
    });
  });
});

describe("getCircleForUser — missing ≡ inaccessible", () => {
  it("matches the browser getCircle path and collapses missing/foreign/malformed to null", async () => {
    const t = convexTest(schema, modules);
    const { ada, grace, sharedId } = await seedOverlappingUsers(t);

    await t.run(async (ctx) => {
      const adaView = await getCircleForUser(ctx, sharedId, ada.owner);
      expect(adaView?.id).toBe(sharedId);
      expect(adaView?.name).toBe("Shared Trip");

      expect(await getCircleForUser(ctx, sharedId, grace.owner)).toEqual(adaView);
      expect(await getCircleForUser(ctx, ada.personalCircleId, grace.owner)).toBeNull();
      expect(await getCircleForUser(ctx, "not-a-circle", ada.owner)).toBeNull();
      expect(await getCircleForUser(ctx, String(grace.personalCircleId), ada.owner)).toBeNull();
    });

    signInAs(ada.owner);
    const browser = await t.query(api.circles.getCircle, { circleId: sharedId });
    await t.run(async (ctx) => {
      expect(browser).toEqual(await getCircleForUser(ctx, sharedId, ada.owner));
    });

    signInAs(grace.owner);
    expect(await t.query(api.circles.getCircle, { circleId: ada.personalCircleId })).toBeNull();
    signInAs(null);
    expect(await t.query(api.circles.getCircle, { circleId: sharedId })).toBeNull();
  });

  it("keeps Archived Circles readable for active Members on both paths", async () => {
    const t = convexTest(schema, modules);
    const { ada, grace } = await seedOverlappingUsers(t);
    const archivedId = (
      await t.run((ctx) =>
        seedOwnedCircle(ctx, ada.owner, {
          name: "Archived Shared",
          archived: true,
          setupCompletedAt: Date.now(),
        }),
      )
    ).circleId;
    await t.run(async (ctx) => {
      await ctx.db.insert("members", {
        circleId: archivedId,
        userId: grace.owner._id,
        role: "member",
        status: "active",
        displayName: grace.owner.displayName,
        joinedAt: Date.now(),
      });
    });

    await t.run(async (ctx) => {
      const explicit = await getCircleForUser(ctx, archivedId, grace.owner);
      expect(explicit?.status).toBe("archived");
      expect(explicit?.name).toBe("Archived Shared");
    });

    signInAs(grace.owner);
    const browser = await t.query(api.circles.getCircle, { circleId: archivedId });
    expect(browser?.status).toBe("archived");
    await t.run(async (ctx) => {
      expect(browser).toEqual(await getCircleForUser(ctx, archivedId, grace.owner));
    });
  });
});

describe("resolveUserById + ops without a browser session", () => {
  it("trusted code can load a User by id and run ops with no session", async () => {
    const t = convexTest(schema, modules);
    signInAs(null);
    const { userId, personalCircleId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "solo@example.com",
        displayName: "Solo",
        onboarded: true,
      }),
    );

    await t.run(async (ctx) => {
      const user = await resolveUserById(ctx, userId);
      expect(user).toBeTruthy();
      if (!user) {
        return;
      }
      expect(toCurrentUserView(user).email).toBe("solo@example.com");
      expect((await listMyCirclesForUser(ctx, user)).map((c) => c.id)).toEqual([personalCircleId]);
      expect((await getCircleForUser(ctx, personalCircleId, user))?.id).toBe(personalCircleId);
    });

    await expect(t.query(api.circles.listMyCircles, {})).rejects.toThrow("Not authenticated");
    expect(await t.query(api.users.getCurrentUser, {})).toBeNull();
  });
});
