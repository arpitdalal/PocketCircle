import { buildRef, MUTATION_ERRORS, mutationErrorData } from "@pocketcircle/domain";
import { capturedRequests, HttpResponse, http, resetCapturedRequests } from "@pocketcircle/mocks";
import { server } from "@pocketcircle/mocks/server";
import { ConvexError } from "convex/values";
import { convexTest as createConvexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mutateAndDrain, mutateAndDrainRetries } from "../test/mutateAndDrain.js";
import { registerEmailWorkpool } from "../test/registerEmailWorkpool.js";
import {
  addMember,
  seedCircle,
  seedFeedbackEmailEvent,
  seedPersonalCircleOwner,
} from "../test/seed.js";
import { enableSentryReporting, sentryNodeSdk } from "../test/sentry-boundary.js";
import { api } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
import { EMAIL_RETRY_BEHAVIOR } from "./email.js";
import { circleEntity, listEntityHistory } from "./history.js";
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
const DAY_MS = 24 * 60 * 60 * 1000;

function createTestConvex() {
  const t = createConvexTest(schema, modules);
  registerEmailWorkpool(t);
  return t;
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

async function countCircleScopedRows(
  ctx: MutationCtx,
  circleId: Id<"circles">,
  ownerUserId: Id<"users">,
) {
  const [histories, notifications, transactions, categories, members] = await Promise.all([
    listEntityHistory(ctx, circleEntity(circleId)),
    ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", ownerUserId))
      .collect(),
    ctx.db
      .query("transactions")
      .withIndex("by_circle", (q) => q.eq("circleId", circleId))
      .collect(),
    ctx.db
      .query("categories")
      .withIndex("by_circle", (q) => q.eq("circleId", circleId))
      .collect(),
    ctx.db
      .query("members")
      .withIndex("by_circle", (q) => q.eq("circleId", circleId))
      .collect(),
  ]);
  return {
    histories: histories.length,
    notifications: notifications.length,
    transactions: transactions.length,
    categories: categories.length,
    members: members.length,
  };
}

beforeEach(() => {
  resetCapturedRequests();
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubEnv("RESEND_FROM_EMAIL", "no-reply@pocketcircle.test");
  vi.stubEnv("SUPPORT_EMAIL", "support@pocketcircle.test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("submitFeedback", () => {
  it("requires authentication", async () => {
    const t = createTestConvex();
    mockCurrentUser.mockResolvedValue(null);

    await expect(
      t.mutation(api.feedback.submitFeedback, {
        type: "bug",
        message: "Broken button",
        appVersion: "0.1.0",
      }),
    ).rejects.toThrow("Not authenticated");
  });

  it("rejects a blank app version", async () => {
    const t = createTestConvex();
    const seed = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    mockCurrentUser.mockResolvedValue(seed.owner);

    await expect(
      t.mutation(api.feedback.submitFeedback, {
        type: "bug",
        message: "Hi",
        appVersion: "   ",
      }),
    ).rejects.toThrow("App version is required");

    await t.run(async (ctx) => {
      const events = await ctx.db.query("feedbackEmailEvents").collect();
      expect(events).toHaveLength(0);
    });
    expect(capturedRequests.filter((r) => r.vendor === "resend")).toHaveLength(0);
  });

  it("inserts only rate-limit metadata and sends one support email", async () => {
    const t = createTestConvex();
    const seed = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada Lovelace",
        onboarded: true,
      }),
    );
    mockCurrentUser.mockResolvedValue(seed.owner);

    await mutateAndDrain(t, () =>
      t.mutation(api.feedback.submitFeedback, {
        type: "bug",
        message: "  The save button fails  ",
        appVersion: "1.2.3",
        circleId: seed.personalCircleId,
      }),
    );

    await t.run(async (ctx) => {
      const events = await ctx.db.query("feedbackEmailEvents").collect();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        userId: seed.owner._id,
        type: "bug",
      });
      expect(events[0]).not.toHaveProperty("message");
    });

    const resend = capturedRequests.filter((r) => r.vendor === "resend");
    expect(resend).toHaveLength(1);
    expect(resend[0]?.body).toMatchObject({ to: "support@pocketcircle.test" });
    const html = resendBodyHtml(resend[0]?.body);
    expect(html).toContain("The save button fails");
    expect(html).toContain("ada@example.com");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("1.2.3");
    expect(html).toContain(seed.owner.displayName);
  });

  it("does not create or mutate Circle-scoped data", async () => {
    const t = createTestConvex();
    const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
    mockCurrentUser.mockResolvedValue(owner);

    const before = await t.run((ctx) => countCircleScopedRows(ctx, circleId, owner._id));

    await mutateAndDrain(t, () =>
      t.mutation(api.feedback.submitFeedback, {
        type: "feature",
        message: "Export CSV",
        appVersion: "0.1.0",
        circleId,
      }),
    );

    const after = await t.run((ctx) => countCircleScopedRows(ctx, circleId, owner._id));
    expect(after).toEqual(before);
  });

  it("omits Circle context when the caller cannot access the Circle", async () => {
    const t = createTestConvex();
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const outsider = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "outsider@example.com",
        displayName: "Outsider",
        onboarded: true,
      }),
    );
    mockCurrentUser.mockResolvedValue(outsider.owner);

    await mutateAndDrain(t, () =>
      t.mutation(api.feedback.submitFeedback, {
        type: "bug",
        message: "Cannot see this circle",
        appVersion: "0.1.0",
        circleId,
      }),
    );

    const html = resendBodyHtml(capturedRequests.filter((r) => r.vendor === "resend")[0]?.body);
    expect(html).not.toContain("Trip");
    expect(html).not.toContain("<strong>Circle:</strong>");
    expect(html).not.toContain(circleId);
  });

  it("rejects the 21st submission inside the rolling day", async () => {
    const t = createTestConvex();
    const seed = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    mockCurrentUser.mockResolvedValue(seed.owner);

    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 20; i++) {
        await seedFeedbackEmailEvent(ctx, {
          userId: seed.owner._id,
          type: "bug",
          sentAt: now - 1000,
        });
      }
    });

    await expect(
      t.mutation(api.feedback.submitFeedback, {
        type: "bug",
        message: "One more",
        appVersion: "0.1.0",
      }),
    ).rejects.toMatchObject({
      data: mutationErrorData(MUTATION_ERRORS.feedbackDailyCapReached),
    });
  });

  it("does not count submissions outside the rolling 24 h window", async () => {
    const t = createTestConvex();
    const seed = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    mockCurrentUser.mockResolvedValue(seed.owner);

    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 20; i++) {
        await seedFeedbackEmailEvent(ctx, {
          userId: seed.owner._id,
          type: "bug",
          sentAt: now - DAY_MS - 1000,
        });
      }
    });

    await mutateAndDrain(t, () =>
      t.mutation(api.feedback.submitFeedback, {
        type: "currency",
        message: "Add AUD",
        appVersion: "0.1.0",
      }),
    );

    expect(capturedRequests.filter((r) => r.vendor === "resend")).toHaveLength(1);
  });

  it("does not throw when SUPPORT_EMAIL is unset", async () => {
    vi.stubEnv("SUPPORT_EMAIL", "");
    const t = createTestConvex();
    const seed = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    mockCurrentUser.mockResolvedValue(seed.owner);

    await mutateAndDrain(t, () =>
      t.mutation(api.feedback.submitFeedback, {
        type: "bug",
        message: "Still ok",
        appVersion: "0.1.0",
      }),
    );

    expect(capturedRequests.filter((r) => r.vendor === "resend")).toHaveLength(0);
    await t.run(async (ctx) => {
      const events = await ctx.db.query("feedbackEmailEvents").collect();
      expect(events).toHaveLength(1);
    });
  });

  it("reports via Workpool onComplete when Resend exhausts retries", async () => {
    enableSentryReporting();
    server.use(
      http.post("https://api.resend.com/emails", () =>
        HttpResponse.json({ message: "fail" }, { status: 500 }),
      ),
    );
    const t = createTestConvex();
    const seed = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    mockCurrentUser.mockResolvedValue(seed.owner);

    await mutateAndDrainRetries(
      t,
      () =>
        t.mutation(api.feedback.submitFeedback, {
          type: "bug",
          message: "Broken button",
          appVersion: "0.1.0",
        }),
      EMAIL_RETRY_BEHAVIOR,
    );

    const eventId = await t.run(async (ctx) => {
      const events = await ctx.db.query("feedbackEmailEvents").collect();
      expect(events).toHaveLength(1);
      return events[0]?._id;
    });
    expect(sentryNodeSdk.captureEvent).toHaveBeenCalledOnce();
    const [event] = sentryNodeSdk.captureEvent.mock.calls[0] ?? [];
    expect(event).toMatchObject({
      message: "feedback_email_exhausted",
      extra: {
        entityId: eventId,
        error: expect.stringContaining("Resend send failed: 500"),
      },
    });
    expect(JSON.stringify(event)).not.toContain("Broken button");
    expect(JSON.stringify(event)).not.toContain("ada@example.com");
  });

  it("throws ConvexError for coded daily cap failures", async () => {
    const t = createTestConvex();
    const seed = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
        onboarded: true,
      }),
    );
    mockCurrentUser.mockResolvedValue(seed.owner);

    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 20; i++) {
        await seedFeedbackEmailEvent(ctx, {
          userId: seed.owner._id,
          type: "feature",
          sentAt: now - 500,
        });
      }
    });

    try {
      await t.mutation(api.feedback.submitFeedback, {
        type: "bug",
        message: "blocked",
        appVersion: "0.1.0",
      });
      expect.unreachable("expected cap");
    } catch (error) {
      expect(error).toBeInstanceOf(ConvexError);
    }
  });

  it("includes Circle context when the caller is a member", async () => {
    const t = createTestConvex();
    const { circleId } = await t.run((ctx) => seedCircle(ctx));
    const member = await t.run((ctx) => addMember(ctx, circleId, "m@example.com", "Maya"));
    mockCurrentUser.mockResolvedValue(member.user);

    await mutateAndDrain(t, () =>
      t.mutation(api.feedback.submitFeedback, {
        type: "bug",
        message: "From a member",
        appVersion: "0.1.0",
        circleId,
      }),
    );

    const html = resendBodyHtml(capturedRequests.filter((r) => r.vendor === "resend")[0]?.body);
    expect(html).toContain("<strong>Circle:</strong>");
    expect(html).toContain("Trip");
    expect(html).toContain(buildRef("Trip", circleId));
  });

  it("omits Circle name and ref when circleId is not provided", async () => {
    const t = createTestConvex();
    const seed = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada Lovelace",
        onboarded: true,
      }),
    );
    mockCurrentUser.mockResolvedValue(seed.owner);

    await mutateAndDrain(t, () =>
      t.mutation(api.feedback.submitFeedback, {
        type: "bug",
        message: "No circle attached",
        appVersion: "0.1.0",
      }),
    );

    const html = resendBodyHtml(capturedRequests.filter((r) => r.vendor === "resend")[0]?.body);
    expect(html).not.toContain("<strong>Circle:</strong>");
    expect(html).not.toContain(seed.personalCircleId);
  });
});
