import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { seedOwnedCircle, seedPersonalCircleOwner } from "../test/seed.js";
import type { Id } from "./_generated/dataModel.js";
import { finalizeOnUserDelete } from "./accountDeletionFinalize.js";
import {
  activateMcpGrant,
  authorizeMcpGrant,
  authorizeMcpGrantForCircle,
  createPendingMcpGrant,
  recordMcpGrantUse,
  revokeAllMcpGrantsForUser,
  revokeMcpGrant,
} from "./mcpGrant.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

type TestCtx = ReturnType<typeof convexTest>;

const CLIENT = "https://mcp-client.example/client.json";
const READ_WRITE = ["pocketcircle:read", "pocketcircle:write"] as const;

async function seedUserWithCircles(t: TestCtx) {
  const ada = await t.run((ctx) =>
    seedPersonalCircleOwner(ctx, {
      email: "ada@example.com",
      displayName: "Ada Lovelace",
      onboarded: true,
    }),
  );
  const regular = await t.run((ctx) =>
    seedOwnedCircle(ctx, ada.owner, {
      name: "Shared Trip",
      setupCompletedAt: Date.now(),
    }),
  );
  const other = await t.run((ctx) =>
    seedPersonalCircleOwner(ctx, {
      email: "grace@example.com",
      displayName: "Grace Hopper",
      onboarded: true,
    }),
  );
  return {
    ada,
    personalId: ada.personalCircleId,
    regularId: regular.circleId,
    otherPersonalId: other.personalCircleId,
    otherUserId: other.userId,
  };
}

async function createActiveGrant(
  t: TestCtx,
  args: {
    userId: Id<"users">;
    circleIds: string[];
    scopes?: readonly string[];
    clientId?: string;
    workerGrantId?: string;
  },
) {
  const pending = await t.run((ctx) =>
    createPendingMcpGrant(ctx, {
      userId: args.userId,
      clientId: args.clientId ?? CLIENT,
      clientDisplaySnapshot: { clientName: "Example Client" },
      scopes: args.scopes ?? READ_WRITE,
      allowedCircleIds: args.circleIds,
    }),
  );
  expect(pending.ok).toBe(true);
  if (!pending.ok) {
    throw new Error(pending.error);
  }
  const activated = await t.run((ctx) =>
    activateMcpGrant(ctx, {
      grantId: pending.value._id,
      workerGrantId: args.workerGrantId ?? `worker-${pending.value._id}`,
      principalId: pending.value.principalId,
    }),
  );
  expect(activated.ok).toBe(true);
  if (!activated.ok) {
    throw new Error(activated.error);
  }
  return activated.value;
}

describe("createPendingMcpGrant", () => {
  it("records User, opaque principal, client snapshot, scopes, Circles, pending status, timestamps", async () => {
    const t = convexTest(schema, modules);
    const { ada, personalId, regularId } = await seedUserWithCircles(t);
    const now = 1_700_000_000_000;

    const result = await t.run((ctx) =>
      createPendingMcpGrant(ctx, {
        userId: ada.userId,
        clientId: CLIENT,
        clientDisplaySnapshot: {
          clientName: "Courier",
          clientUri: "https://courier.example",
          logoUri: "https://courier.example/logo.png",
        },
        scopes: ["pocketcircle:write", "openid", "pocketcircle:read"],
        allowedCircleIds: [personalId, regularId],
        now,
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        userId: ada.userId,
        clientId: CLIENT,
        clientDisplaySnapshot: {
          clientName: "Courier",
          clientUri: "https://courier.example",
          logoUri: "https://courier.example/logo.png",
        },
        scopes: ["pocketcircle:read", "pocketcircle:write"],
        allowedCircleIds: [personalId, regularId],
        status: "pending",
        createdAt: now,
        updatedAt: now,
        workerCleanupStatus: "none",
      },
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.value.principalId.length).toBeGreaterThan(20);
    expect(result.value.workerGrantId).toBeUndefined();
    expect(result.value.lastUsedAt).toBeUndefined();
  });

  it("rejects unknown scopes, empty Circles, inaccessible Circles, and empty client id", async () => {
    const t = convexTest(schema, modules);
    const { ada, personalId, otherPersonalId } = await seedUserWithCircles(t);

    await t.run(async (ctx) => {
      expect(
        await createPendingMcpGrant(ctx, {
          userId: ada.userId,
          clientId: CLIENT,
          scopes: ["openid"],
          allowedCircleIds: [personalId],
        }),
      ).toEqual({ ok: false, error: "invalid_scopes" });

      expect(
        await createPendingMcpGrant(ctx, {
          userId: ada.userId,
          clientId: CLIENT,
          scopes: READ_WRITE,
          allowedCircleIds: [],
        }),
      ).toEqual({ ok: false, error: "invalid_circles" });

      expect(
        await createPendingMcpGrant(ctx, {
          userId: ada.userId,
          clientId: CLIENT,
          scopes: READ_WRITE,
          allowedCircleIds: [personalId, otherPersonalId],
        }),
      ).toEqual({ ok: false, error: "invalid_circles" });

      expect(
        await createPendingMcpGrant(ctx, {
          userId: ada.userId,
          clientId: "  ",
          scopes: READ_WRITE,
          allowedCircleIds: [personalId],
        }),
      ).toEqual({ ok: false, error: "invalid_client" });
    });
  });
});

describe("activateMcpGrant / revokeMcpGrant transitions", () => {
  it("activates pending with Worker linkage and rejects invalid or repeated transitions", async () => {
    const t = convexTest(schema, modules);
    const { ada, personalId } = await seedUserWithCircles(t);

    const pending = await t.run((ctx) =>
      createPendingMcpGrant(ctx, {
        userId: ada.userId,
        clientId: CLIENT,
        scopes: ["pocketcircle:read"],
        allowedCircleIds: [personalId],
      }),
    );
    if (!pending.ok) {
      throw new Error(pending.error);
    }

    await t.run(async (ctx) => {
      expect(
        await activateMcpGrant(ctx, {
          grantId: pending.value._id,
          workerGrantId: "",
          principalId: pending.value.principalId,
        }),
      ).toEqual({ ok: false, error: "worker_grant_required" });

      expect(
        await activateMcpGrant(ctx, {
          grantId: pending.value._id,
          workerGrantId: "wg-1",
          principalId: "wrong-principal",
        }),
      ).toEqual({ ok: false, error: "principal_mismatch" });
    });

    const first = await t.run((ctx) =>
      activateMcpGrant(ctx, {
        grantId: pending.value._id,
        workerGrantId: "wg-1",
        principalId: pending.value.principalId,
      }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error(first.error);
    }
    expect(first.value).toMatchObject({
      status: "active",
      workerGrantId: "wg-1",
      workerCleanupStatus: "none",
    });
    expect(first.value.activatedAt).toEqual(expect.any(Number));

    const second = await t.run((ctx) =>
      activateMcpGrant(ctx, {
        grantId: pending.value._id,
        workerGrantId: "wg-2",
        principalId: pending.value.principalId,
      }),
    );
    expect(second).toEqual({ ok: false, error: "invalid_transition" });

    const revoked = await t.run((ctx) => revokeMcpGrant(ctx, { grantId: pending.value._id }));
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) {
      throw new Error(revoked.error);
    }
    expect(revoked.value).toMatchObject({
      status: "revoked",
      workerCleanupStatus: "pending_revoke",
    });
    expect(revoked.value.revokedAt).toEqual(expect.any(Number));

    const again = await t.run((ctx) => revokeMcpGrant(ctx, { grantId: pending.value._id }));
    expect(again).toEqual({ ok: true, value: revoked.value });

    const reactivate = await t.run((ctx) =>
      activateMcpGrant(ctx, {
        grantId: pending.value._id,
        workerGrantId: "wg-3",
        principalId: pending.value.principalId,
      }),
    );
    expect(reactivate).toEqual({ ok: false, error: "invalid_transition" });
  });

  it("supersedes older pending/active grants for the same User and client on activation", async () => {
    const t = convexTest(schema, modules);
    const { ada, personalId, regularId } = await seedUserWithCircles(t);

    // Active first, then a later pending sibling — activation of a newer grant
    // must revoke both (Cloudflare-style replacement for the same User+client).
    const olderActive = await createActiveGrant(t, {
      userId: ada.userId,
      circleIds: [personalId],
      scopes: ["pocketcircle:read"],
      workerGrantId: "wg-old",
    });
    const olderPending = await t.run((ctx) =>
      createPendingMcpGrant(ctx, {
        userId: ada.userId,
        clientId: CLIENT,
        scopes: ["pocketcircle:read"],
        allowedCircleIds: [personalId],
      }),
    );
    const newer = await t.run((ctx) =>
      createPendingMcpGrant(ctx, {
        userId: ada.userId,
        clientId: CLIENT,
        scopes: READ_WRITE,
        allowedCircleIds: [personalId, regularId],
      }),
    );
    if (!olderPending.ok || !newer.ok) {
      throw new Error("setup failed");
    }

    const activated = await t.run((ctx) =>
      activateMcpGrant(ctx, {
        grantId: newer.value._id,
        workerGrantId: "wg-new",
        principalId: newer.value.principalId,
      }),
    );
    expect(activated.ok).toBe(true);

    await t.run(async (ctx) => {
      expect((await ctx.db.get(olderPending.value._id))?.status).toBe("revoked");
      expect((await ctx.db.get(olderActive._id))?.status).toBe("revoked");
      expect((await ctx.db.get(olderActive._id))?.workerCleanupStatus).toBe("pending_revoke");
      expect((await ctx.db.get(newer.value._id))?.status).toBe("active");
    });
  });

  it("rejects concurrent second activation without leaving a non-active grant", async () => {
    const t = convexTest(schema, modules);
    const { ada, personalId } = await seedUserWithCircles(t);

    const pending = await t.run((ctx) =>
      createPendingMcpGrant(ctx, {
        userId: ada.userId,
        clientId: CLIENT,
        scopes: ["pocketcircle:read"],
        allowedCircleIds: [personalId],
      }),
    );
    if (!pending.ok) {
      throw new Error(pending.error);
    }

    const [a, b] = await Promise.all([
      t.run((ctx) =>
        activateMcpGrant(ctx, {
          grantId: pending.value._id,
          workerGrantId: "wg-a",
          principalId: pending.value.principalId,
        }),
      ),
      t.run((ctx) =>
        activateMcpGrant(ctx, {
          grantId: pending.value._id,
          workerGrantId: "wg-b",
          principalId: pending.value.principalId,
        }),
      ),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    expect(outcomes.filter((r) => !r.ok && r.error === "invalid_transition")).toHaveLength(1);

    await t.run(async (ctx) => {
      const grant = await ctx.db.get(pending.value._id);
      expect(grant?.status).toBe("active");
      expect(["wg-a", "wg-b"]).toContain(grant?.workerGrantId);
    });
  });

  it("revoke during activation fails closed — grant is never left pending after both complete", async () => {
    const t = convexTest(schema, modules);
    const { ada, personalId } = await seedUserWithCircles(t);

    const pending = await t.run((ctx) =>
      createPendingMcpGrant(ctx, {
        userId: ada.userId,
        clientId: CLIENT,
        scopes: ["pocketcircle:read"],
        allowedCircleIds: [personalId],
      }),
    );
    if (!pending.ok) {
      throw new Error(pending.error);
    }

    await Promise.all([
      t.run((ctx) => revokeMcpGrant(ctx, { grantId: pending.value._id })),
      t.run((ctx) =>
        activateMcpGrant(ctx, {
          grantId: pending.value._id,
          workerGrantId: "wg-race",
          principalId: pending.value.principalId,
        }),
      ),
    ]);

    await t.run(async (ctx) => {
      const grant = await ctx.db.get(pending.value._id);
      expect(grant?.status === "revoked" || grant?.status === "active").toBe(true);
      expect(grant?.status).not.toBe("pending");
      if (grant?.status === "active") {
        // Activate won the race; a follow-up revoke must still work and block authz.
        const revoked = await revokeMcpGrant(ctx, { grantId: grant._id });
        expect(revoked.ok).toBe(true);
        expect(
          await authorizeMcpGrant(ctx, {
            grantId: grant._id,
            effectiveScopes: ["pocketcircle:read"],
            requiredScope: "pocketcircle:read",
          }),
        ).toMatchObject({ ok: false, denial: { kind: "grant_unavailable", status: "revoked" } });
      } else {
        expect(grant).not.toBeNull();
        if (!grant) {
          return;
        }
        expect(
          grant.workerGrantId === undefined || grant.workerCleanupStatus === "pending_revoke",
        ).toBe(true);
        expect(
          await authorizeMcpGrant(ctx, {
            grantId: grant._id,
            effectiveScopes: ["pocketcircle:read"],
            requiredScope: "pocketcircle:read",
          }),
        ).toMatchObject({ ok: false, denial: { kind: "grant_unavailable", status: "revoked" } });
      }
    });
  });

  it("rejects Worker grant id already linked to another Convex grant", async () => {
    const t = convexTest(schema, modules);
    const { ada, personalId } = await seedUserWithCircles(t);
    await createActiveGrant(t, {
      userId: ada.userId,
      circleIds: [personalId],
      workerGrantId: "shared-wg",
    });
    const pending = await t.run((ctx) =>
      createPendingMcpGrant(ctx, {
        userId: ada.userId,
        clientId: `${CLIENT}#other`,
        scopes: ["pocketcircle:read"],
        allowedCircleIds: [personalId],
      }),
    );
    if (!pending.ok) {
      throw new Error(pending.error);
    }
    const conflict = await t.run((ctx) =>
      activateMcpGrant(ctx, {
        grantId: pending.value._id,
        workerGrantId: "shared-wg",
        principalId: pending.value.principalId,
      }),
    );
    expect(conflict).toEqual({ ok: false, error: "worker_grant_conflict" });
  });

  it("failed activation does not revoke sibling grants", async () => {
    const t = convexTest(schema, modules);
    const { ada, personalId } = await seedUserWithCircles(t);
    const sibling = await createActiveGrant(t, {
      userId: ada.userId,
      circleIds: [personalId],
      workerGrantId: "wg-sibling",
    });
    const pending = await t.run((ctx) =>
      createPendingMcpGrant(ctx, {
        userId: ada.userId,
        clientId: CLIENT,
        scopes: ["pocketcircle:read"],
        allowedCircleIds: [personalId],
      }),
    );
    if (!pending.ok) {
      throw new Error(pending.error);
    }

    const failed = await t.run((ctx) =>
      activateMcpGrant(ctx, {
        grantId: pending.value._id,
        workerGrantId: "wg-fail",
        principalId: "wrong-principal",
      }),
    );
    expect(failed).toEqual({ ok: false, error: "principal_mismatch" });

    await t.run(async (ctx) => {
      expect((await ctx.db.get(sibling._id))?.status).toBe("active");
      expect((await ctx.db.get(pending.value._id))?.status).toBe("pending");
    });
  });
});

describe("authorizeMcpGrant / authorizeMcpGrantForCircle", () => {
  it("requires active grant and effective token scope ∩ live grant scope", async () => {
    const t = convexTest(schema, modules);
    const { ada, personalId } = await seedUserWithCircles(t);

    const pending = await t.run((ctx) =>
      createPendingMcpGrant(ctx, {
        userId: ada.userId,
        clientId: CLIENT,
        scopes: READ_WRITE,
        allowedCircleIds: [personalId],
      }),
    );
    if (!pending.ok) {
      throw new Error(pending.error);
    }

    await t.run(async (ctx) => {
      expect(
        await authorizeMcpGrant(ctx, {
          grantId: pending.value._id,
          effectiveScopes: READ_WRITE,
          requiredScope: "pocketcircle:read",
        }),
      ).toMatchObject({ ok: false, denial: { kind: "grant_unavailable", status: "pending" } });
    });

    const grant = await createActiveGrant(t, {
      userId: ada.userId,
      circleIds: [personalId],
      scopes: READ_WRITE,
    });

    await t.run(async (ctx) => {
      const ok = await authorizeMcpGrant(ctx, {
        grantId: grant._id,
        effectiveScopes: READ_WRITE,
        requiredScope: "pocketcircle:read",
      });
      expect(ok.ok).toBe(true);

      // Downscoped token: grant has write, token does not.
      const downscoped = await authorizeMcpGrant(ctx, {
        grantId: grant._id,
        effectiveScopes: ["pocketcircle:read"],
        requiredScope: "pocketcircle:write",
      });
      expect(downscoped).toEqual({
        ok: false,
        denial: {
          kind: "insufficient_scope",
          requiredScope: "pocketcircle:write",
          grantLacksScope: false,
          scopeCouldFix: true,
        },
      });
    });

    const readOnlyGrant = await createActiveGrant(t, {
      userId: ada.userId,
      circleIds: [personalId],
      scopes: ["pocketcircle:read"],
      clientId: `${CLIENT}#ro`,
    });
    await t.run(async (ctx) => {
      expect(
        await authorizeMcpGrant(ctx, {
          grantId: readOnlyGrant._id,
          effectiveScopes: READ_WRITE,
          requiredScope: "pocketcircle:write",
        }),
      ).toEqual({
        ok: false,
        denial: {
          kind: "insufficient_scope",
          requiredScope: "pocketcircle:write",
          grantLacksScope: true,
          scopeCouldFix: true,
        },
      });
    });

    await t.run((ctx) => revokeMcpGrant(ctx, { grantId: grant._id }));
    await t.run(async (ctx) => {
      expect(
        await authorizeMcpGrant(ctx, {
          grantId: grant._id,
          effectiveScopes: READ_WRITE,
          requiredScope: "pocketcircle:read",
        }),
      ).toMatchObject({ ok: false, denial: { kind: "grant_unavailable", status: "revoked" } });
    });
  });

  it("enforces selected Circles, live membership, and Owner-only app permission without leaking Circle existence", async () => {
    const t = convexTest(schema, modules);
    const { ada, personalId, regularId, otherPersonalId } = await seedUserWithCircles(t);
    const grant = await createActiveGrant(t, {
      userId: ada.userId,
      circleIds: [personalId],
      scopes: READ_WRITE,
    });

    const denials = await t.run(async (ctx) => {
      const selected = await authorizeMcpGrantForCircle(ctx, {
        grantId: grant._id,
        effectiveScopes: READ_WRITE,
        requiredScope: "pocketcircle:read",
        circleId: personalId,
        requiredPermission: "member",
      });
      expect(selected.ok).toBe(true);

      const deselected = await authorizeMcpGrantForCircle(ctx, {
        grantId: grant._id,
        effectiveScopes: READ_WRITE,
        requiredScope: "pocketcircle:read",
        circleId: regularId,
        requiredPermission: "member",
      });
      const foreign = await authorizeMcpGrantForCircle(ctx, {
        grantId: grant._id,
        effectiveScopes: READ_WRITE,
        requiredScope: "pocketcircle:read",
        circleId: otherPersonalId,
        requiredPermission: "member",
      });
      const malformed = await authorizeMcpGrantForCircle(ctx, {
        grantId: grant._id,
        effectiveScopes: READ_WRITE,
        requiredScope: "pocketcircle:read",
        circleId: "not-a-circle-id",
        requiredPermission: "member",
      });
      const missing = await authorizeMcpGrantForCircle(ctx, {
        grantId: grant._id,
        effectiveScopes: READ_WRITE,
        requiredScope: "pocketcircle:read",
        circleId: grant._id,
        requiredPermission: "member",
      });
      return { deselected, foreign, malformed, missing };
    });

    for (const denial of Object.values(denials)) {
      expect(denial).toEqual({ ok: false, denial: { kind: "circle_inaccessible" } });
    }

    // New Circles never appear on an existing grant automatically.
    const both = await createActiveGrant(t, {
      userId: ada.userId,
      circleIds: [personalId, regularId],
      scopes: ["pocketcircle:read"],
      clientId: `${CLIENT}#both`,
    });
    await t.run(async (ctx) => {
      // Grant that only selected personal must still deny regular even though User is a Member.
      expect(
        (
          await authorizeMcpGrantForCircle(ctx, {
            grantId: grant._id,
            effectiveScopes: ["pocketcircle:read"],
            requiredScope: "pocketcircle:read",
            circleId: regularId,
            requiredPermission: "member",
          })
        ).ok,
      ).toBe(false);
      expect(
        (
          await authorizeMcpGrantForCircle(ctx, {
            grantId: both._id,
            effectiveScopes: ["pocketcircle:read"],
            requiredScope: "pocketcircle:read",
            circleId: regularId,
            requiredPermission: "member",
          })
        ).ok,
      ).toBe(true);
    });

    // Remove membership — grant unchanged, next check fails like deselected.
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("members")
        .withIndex("by_circle_and_user", (q) =>
          q.eq("circleId", personalId).eq("userId", ada.userId),
        )
        .unique();
      if (!membership) {
        throw new Error("membership missing");
      }
      await ctx.db.patch(membership._id, { status: "removed", removedAt: Date.now() });
    });

    await t.run(async (ctx) => {
      const grantRow = await ctx.db.get(grant._id);
      expect(grantRow?.allowedCircleIds).toEqual([personalId]);
      expect(grantRow?.status).toBe("active");
      expect(
        await authorizeMcpGrantForCircle(ctx, {
          grantId: grant._id,
          effectiveScopes: READ_WRITE,
          requiredScope: "pocketcircle:read",
          circleId: personalId,
          requiredPermission: "member",
        }),
      ).toEqual({ ok: false, denial: { kind: "circle_inaccessible" } });
    });
  });

  it("distinguishes Owner-only app permission failures from scope failures", async () => {
    const t = convexTest(schema, modules);
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    const grace = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "grace@example.com",
        displayName: "Grace",
        onboarded: true,
      }),
    );
    const shared = await t.run(async (ctx) => {
      const owned = await seedOwnedCircle(ctx, ada.owner, {
        name: "Shared",
        setupCompletedAt: Date.now(),
      });
      await ctx.db.insert("members", {
        circleId: owned.circleId,
        userId: grace.userId,
        role: "member",
        status: "active",
        displayName: grace.owner.displayName,
        joinedAt: Date.now(),
      });
      return owned.circleId;
    });

    const memberGrant = await createActiveGrant(t, {
      userId: grace.userId,
      circleIds: [shared],
      scopes: READ_WRITE,
    });

    await t.run(async (ctx) => {
      const memberOk = await authorizeMcpGrantForCircle(ctx, {
        grantId: memberGrant._id,
        effectiveScopes: READ_WRITE,
        requiredScope: "pocketcircle:write",
        circleId: shared,
        requiredPermission: "member",
      });
      expect(memberOk.ok).toBe(true);

      const ownerDenied = await authorizeMcpGrantForCircle(ctx, {
        grantId: memberGrant._id,
        effectiveScopes: READ_WRITE,
        requiredScope: "pocketcircle:write",
        circleId: shared,
        requiredPermission: "owner",
      });
      expect(ownerDenied).toEqual({
        ok: false,
        denial: {
          kind: "permission_denied",
          requiredPermission: "owner",
          scopeCouldFix: false,
        },
      });
    });
  });

  it("records optional last-use without changing authorization fields", async () => {
    const t = convexTest(schema, modules);
    const { ada, personalId } = await seedUserWithCircles(t);
    const grant = await createActiveGrant(t, {
      userId: ada.userId,
      circleIds: [personalId],
    });
    const usedAt = 1_800_000_000_000;
    await t.run((ctx) => recordMcpGrantUse(ctx, { grantId: grant._id, now: usedAt }));
    await t.run(async (ctx) => {
      const row = await ctx.db.get(grant._id);
      expect(row?.lastUsedAt).toBe(usedAt);
      expect(row?.allowedCircleIds).toEqual([personalId]);
      expect(row?.status).toBe("active");
    });
  });
});

describe("Account Deletion disables MCP grants", () => {
  it("revokes every grant for the User before the User row is deleted", async () => {
    const t = convexTest(schema, modules);
    // Personal-only User — no Account Deletion blockers from owned regular Circles.
    const ada = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada Lovelace",
        onboarded: true,
      }),
    );
    const active = await createActiveGrant(t, {
      userId: ada.userId,
      circleIds: [ada.personalCircleId],
      workerGrantId: "wg-del",
    });
    const pending = await t.run((ctx) =>
      createPendingMcpGrant(ctx, {
        userId: ada.userId,
        clientId: `${CLIENT}#pending`,
        scopes: ["pocketcircle:read"],
        allowedCircleIds: [ada.personalCircleId],
      }),
    );
    if (!pending.ok) {
      throw new Error(pending.error);
    }

    await t.run((ctx) =>
      finalizeOnUserDelete(ctx, {
        email: ada.owner.email,
        userId: ada.userId,
        name: ada.owner.displayName,
      }),
    );

    await t.run(async (ctx) => {
      expect(await ctx.db.get(ada.userId)).toBeNull();
      const activeRow = await ctx.db.get(active._id);
      const pendingRow = await ctx.db.get(pending.value._id);
      expect(activeRow?.status).toBe("revoked");
      expect(activeRow?.workerCleanupStatus).toBe("pending_revoke");
      expect(pendingRow?.status).toBe("revoked");
      expect(
        await authorizeMcpGrant(ctx, {
          grantId: active._id,
          effectiveScopes: READ_WRITE,
          requiredScope: "pocketcircle:read",
        }),
      ).toMatchObject({ ok: false, denial: { kind: "grant_unavailable" } });
    });
  });

  it("revokeAllMcpGrantsForUser is bounded by the by_user index", async () => {
    const t = convexTest(schema, modules);
    const { ada, personalId, otherUserId, otherPersonalId } = await seedUserWithCircles(t);
    const mine = await createActiveGrant(t, {
      userId: ada.userId,
      circleIds: [personalId],
    });
    const theirs = await createActiveGrant(t, {
      userId: otherUserId,
      circleIds: [otherPersonalId],
      clientId: `${CLIENT}#other-user`,
    });

    await t.run((ctx) => revokeAllMcpGrantsForUser(ctx, { userId: ada.userId }));

    await t.run(async (ctx) => {
      expect((await ctx.db.get(mine._id))?.status).toBe("revoked");
      expect((await ctx.db.get(theirs._id))?.status).toBe("active");
    });
  });
});

describe("mcpGrants indexes", () => {
  it("supports bounded lookup by User, client, status, principal, and reconciliation state", async () => {
    const t = convexTest(schema, modules);
    const { ada, personalId } = await seedUserWithCircles(t);
    const grant = await createActiveGrant(t, {
      userId: ada.userId,
      circleIds: [personalId],
      workerGrantId: "wg-idx",
    });
    await t.run((ctx) => revokeMcpGrant(ctx, { grantId: grant._id }));

    await t.run(async (ctx) => {
      expect(
        (
          await ctx.db
            .query("mcpGrants")
            .withIndex("by_principal", (q) => q.eq("principalId", grant.principalId))
            .unique()
        )?._id,
      ).toBe(grant._id);

      expect(
        (
          await ctx.db
            .query("mcpGrants")
            .withIndex("by_user_and_status", (q) =>
              q.eq("userId", ada.userId).eq("status", "revoked"),
            )
            .collect()
        ).map((g) => g._id),
      ).toContain(grant._id);

      expect(
        (
          await ctx.db
            .query("mcpGrants")
            .withIndex("by_user_client_and_status", (q) =>
              q.eq("userId", ada.userId).eq("clientId", CLIENT).eq("status", "revoked"),
            )
            .collect()
        ).map((g) => g._id),
      ).toContain(grant._id);

      expect(
        (
          await ctx.db
            .query("mcpGrants")
            .withIndex("by_worker_grant", (q) => q.eq("workerGrantId", "wg-idx"))
            .unique()
        )?._id,
      ).toBe(grant._id);

      expect(
        (
          await ctx.db
            .query("mcpGrants")
            .withIndex("by_worker_cleanup_status", (q) =>
              q.eq("workerCleanupStatus", "pending_revoke"),
            )
            .collect()
        ).map((g) => g._id),
      ).toContain(grant._id);
    });
  });
});
