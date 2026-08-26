import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedCircle, seedInvitation } from "../test/seed.js";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
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

function createTestConvex() {
  return convexTest(schema, modules);
}

async function completeSetup(t: ReturnType<typeof createTestConvex>, circleId: Id<"circles">) {
  await t.run(async (ctx) => {
    await ctx.db.patch(circleId, circleSetupFields(Date.now()));
  });
}

async function stashInvitationToken(
  t: ReturnType<typeof createTestConvex>,
  args: {
    circleId: Id<"circles">;
    emailLower: string;
    invitationId: Id<"invitations">;
    token: string;
  },
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("e2eInvitationTokens", {
      circleId: args.circleId,
      emailLower: args.emailLower,
      invitationId: args.invitationId,
      token: args.token,
      updatedAt: Date.now(),
    });
  });
}

beforeEach(() => {
  vi.stubEnv("E2E_TEST_AUTH", "1");
  mockCurrentUser.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getInvitationTokenForE2E", () => {
  it("returns the token when the stash row matches a pending invitation", async () => {
    const t = createTestConvex();
    const email = "ada@example.com";
    const token = generateInvitationToken();
    const tokenHash = await hashInvitationToken(token);

    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await completeSetup(t, circleId);
    mockCurrentUser.mockResolvedValue(owner);

    const invitationId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, {
        email,
        tokenHash,
      }),
    );
    await stashInvitationToken(t, {
      circleId,
      emailLower: email,
      invitationId,
      token,
    });

    await expect(t.query(api.e2e.getInvitationTokenForE2E, { circleId, email })).resolves.toBe(
      token,
    );
  });

  it("returns null when the stash row points at an accepted invitation", async () => {
    const t = createTestConvex();
    const email = "rejoin@example.com";
    const staleToken = generateInvitationToken();
    const staleTokenHash = await hashInvitationToken(staleToken);

    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await completeSetup(t, circleId);
    mockCurrentUser.mockResolvedValue(owner);

    const acceptedInvitationId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, {
        email,
        tokenHash: staleTokenHash,
        status: "accepted",
      }),
    );
    await stashInvitationToken(t, {
      circleId,
      emailLower: email,
      invitationId: acceptedInvitationId,
      token: staleToken,
    });

    const pendingTokenHash = await hashInvitationToken(generateInvitationToken());
    await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, {
        email,
        tokenHash: pendingTokenHash,
        status: "pending",
      }),
    );

    await expect(
      t.query(api.e2e.getInvitationTokenForE2E, { circleId, email }),
    ).resolves.toBeNull();
  });

  it("returns null when the stash token no longer matches the pending invitation hash", async () => {
    const t = createTestConvex();
    const email = "rotate@example.com";
    const currentToken = generateInvitationToken();
    const staleToken = generateInvitationToken();

    const currentTokenHash = await hashInvitationToken(currentToken);

    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    await completeSetup(t, circleId);
    mockCurrentUser.mockResolvedValue(owner);

    const invitationId = await t.run((ctx) =>
      seedInvitation(ctx, circleId, owner._id, {
        email,
        tokenHash: currentTokenHash,
      }),
    );
    await stashInvitationToken(t, {
      circleId,
      emailLower: email,
      invitationId,
      token: staleToken,
    });

    await expect(
      t.query(api.e2e.getInvitationTokenForE2E, { circleId, email }),
    ).resolves.toBeNull();
  });
});

describe("backdateCurrentUserCreatedAtForE2E", () => {
  it("patches the signed-in User createdAt when E2E auth is enabled", async () => {
    const t = createTestConvex();
    const { owner } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    await t.mutation(api.e2e.backdateCurrentUserCreatedAtForE2E, {
      createdAt: Date.parse("2020-01-01T00:00:00.000Z"),
    });

    const updated = await t.run((ctx) => ctx.db.get(owner._id));
    expect(updated?.createdAt).toBe(Date.parse("2020-01-01T00:00:00.000Z"));
  });

  it("rejects when E2E auth is disabled", async () => {
    vi.stubEnv("E2E_TEST_AUTH", "0");
    const t = createTestConvex();
    const { owner } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    await expect(
      t.mutation(api.e2e.backdateCurrentUserCreatedAtForE2E, { createdAt: 1 }),
    ).rejects.toThrow("Forbidden");
  });
});
