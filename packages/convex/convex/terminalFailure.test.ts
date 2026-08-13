import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mutateAndDrain } from "../test/mutateAndDrain.js";
import { seedFeedbackEmailEvent, seedInvitation, seedPersonalCircleOwner } from "../test/seed.js";
import { enableSentryReporting, sentryNodeSdk } from "../test/sentry-boundary.js";
import { internal } from "./_generated/api.js";
import schema from "./schema.js";
import { sanitizeOperationalError } from "./terminalFailure.js";

const modules = import.meta.glob("./**/*.ts");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function createTestConvex() {
  return convexTest(schema, modules);
}

function capturedReport() {
  expect(sentryNodeSdk.captureMessage).toHaveBeenCalledOnce();
  const [message, context] = sentryNodeSdk.captureMessage.mock.calls[0] ?? [];
  expect(message).toBeTypeOf("string");
  expect(context).toBeTypeOf("object");
  return { message, context };
}

describe("sanitizeOperationalError", () => {
  it("redacts emails and URLs while keeping the vendor status", () => {
    expect(
      sanitizeOperationalError(
        'Resend send failed: 401 {"to":"ada@example.com","url":"https://app.example.com/invite/secret-token"}',
      ),
    ).toBe('Resend send failed: 401 {"to":"[redacted-email]","url":"[redacted-url]"}');
  });
});

describe("terminal failure reporting", () => {
  it("reports welcome email exhaustion once with the user id and release", async () => {
    enableSentryReporting();
    const t = createTestConvex();
    const { userId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );

    await mutateAndDrain(t, () =>
      t.mutation(internal.email.onWelcomeRunComplete, {
        workId: "work-1",
        context: { userId },
        result: { kind: "failed", error: "Resend send failed: 503" },
      }),
    );

    const { message, context } = capturedReport();
    expect(message).toBe("welcome_email_exhausted");
    expect(context).toEqual({
      level: "error",
      tags: { failureKind: "welcome_email_exhausted" },
      extra: {
        entityId: userId,
        error: "Resend send failed: 503",
        release: "abc1234",
      },
    });
    expect(sentryNodeSdk.flush).toHaveBeenCalledOnce();
    expect(sentryNodeSdk.init).not.toHaveBeenCalled();
    expect(sentryNodeSdk.initWithoutDefaultIntegrations).toHaveBeenCalledWith({
      dsn: "https://example@sentry.io/1",
      release: "abc1234",
      environment: "test",
      registerEsmLoaderHooks: false,
      integrations: [{ name: "error-only" }],
    });
    expect(sentryNodeSdk.initWithoutDefaultIntegrations.mock.calls[0]?.[0]).not.toHaveProperty(
      "tracesSampleRate",
    );
  });

  it("reports invitation email exhaustion", async () => {
    enableSentryReporting();
    const t = createTestConvex();
    const seed = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const invitationId = await t.run((ctx) =>
      seedInvitation(ctx, seed.personalCircleId, seed.userId, { email: "grace@example.com" }),
    );

    await mutateAndDrain(t, () =>
      t.mutation(internal.email.onInvitationRunComplete, {
        workId: "work-invite",
        context: { invitationId },
        result: { kind: "failed", error: "Resend send failed: 502" },
      }),
    );

    const { message, context } = capturedReport();
    expect(message).toBe("invitation_email_exhausted");
    expect(context).toMatchObject({ extra: { entityId: invitationId } });
  });

  it("reports feedback email exhaustion", async () => {
    enableSentryReporting();
    const t = createTestConvex();
    const seed = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const eventId = await t.run((ctx) =>
      seedFeedbackEmailEvent(ctx, { userId: seed.userId, type: "bug", sentAt: Date.now() }),
    );

    await mutateAndDrain(t, () =>
      t.mutation(internal.email.onFeedbackRunComplete, {
        workId: "work-feedback",
        context: { eventId },
        result: { kind: "failed", error: "Resend send failed: 500" },
      }),
    );

    const { message, context } = capturedReport();
    expect(message).toBe("feedback_email_exhausted");
    expect(context).toMatchObject({ extra: { entityId: eventId } });
  });

  it("reports account-deletion email exhaustion", async () => {
    enableSentryReporting();
    const t = createTestConvex();
    const { userId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );

    await mutateAndDrain(t, () =>
      t.mutation(internal.accountDeletion.onAccountDeletionEmailComplete, {
        workId: "work-delete",
        context: { userId },
        result: { kind: "failed", error: "SITE_URL is required" },
      }),
    );

    const { message, context } = capturedReport();
    expect(message).toBe("account_deletion_email_exhausted");
    expect(context).toMatchObject({ extra: { entityId: userId } });
  });

  it("reports persisted Account Deletion cleanup failure", async () => {
    enableSentryReporting();
    const t = createTestConvex();
    const { userId, owner } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const jobId = await t.run(async (ctx) =>
      ctx.db.insert("accountDeletionJobs", {
        userId,
        emailLower: owner.email,
        finalizedAt: Date.now(),
        phase: "not-a-real-phase",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await mutateAndDrain(t, () => t.mutation(internal.accountDeletion.runCleanupBatch, { jobId }));

    const job = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(job?.failure).toBe("unknown phase: not-a-real-phase");
    const { message, context } = capturedReport();
    expect(message).toBe("account_deletion_cleanup_failed");
    expect(context).toMatchObject({
      extra: { entityId: jobId, error: "unknown phase: not-a-real-phase" },
    });
  });

  it("does not report successful or canceled workpool completions", async () => {
    enableSentryReporting();
    const t = createTestConvex();
    const { userId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );

    await mutateAndDrain(t, async () => {
      await t.mutation(internal.email.onWelcomeRunComplete, {
        workId: "work-ok",
        context: { userId },
        result: { kind: "success", returnValue: null },
      });
      await t.mutation(internal.email.onWelcomeRunComplete, {
        workId: "work-cancel",
        context: { userId },
        result: { kind: "canceled" },
      });
    });

    expect(sentryNodeSdk.captureMessage).not.toHaveBeenCalled();
  });

  it("strips emails and invitation links from the reported error", async () => {
    enableSentryReporting();
    const t = createTestConvex();
    const { userId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );

    await mutateAndDrain(t, () =>
      t.mutation(internal.email.onWelcomeRunComplete, {
        workId: "work-pii",
        context: { userId },
        result: {
          kind: "failed",
          error:
            'Resend send failed: 401 {"to":"ada@example.com","url":"https://app.example.com/invite/secret-token"}',
        },
      }),
    );

    const { context } = capturedReport();
    const extra =
      context && typeof context === "object" && "extra" in context ? context.extra : null;
    expect(extra).toMatchObject({
      error: 'Resend send failed: 401 {"to":"[redacted-email]","url":"[redacted-url]"}',
    });
    expect(JSON.stringify(context)).not.toContain("ada@example.com");
    expect(JSON.stringify(context)).not.toContain("secret-token");
    expect(JSON.stringify(context)).not.toContain("Please add dark mode");
  });

  it("does not throw when Sentry capture itself fails", async () => {
    enableSentryReporting();
    sentryNodeSdk.captureMessage.mockImplementation(() => {
      throw new Error("sentry down");
    });
    const t = createTestConvex();
    const { userId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );

    await expect(
      mutateAndDrain(t, () =>
        t.mutation(internal.email.onWelcomeRunComplete, {
          workId: "work-sentry-fail",
          context: { userId },
          result: { kind: "failed", error: "Resend send failed: 503" },
        }),
      ),
    ).resolves.toBeNull();
  });

  it("skips Sentry when the DSN is unset", async () => {
    const t = createTestConvex();
    const { userId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );

    await mutateAndDrain(t, () =>
      t.mutation(internal.email.onWelcomeRunComplete, {
        workId: "work-no-dsn",
        context: { userId },
        result: { kind: "failed", error: "Resend send failed: 503" },
      }),
    );

    expect(sentryNodeSdk.init).not.toHaveBeenCalled();
    expect(sentryNodeSdk.initWithoutDefaultIntegrations).not.toHaveBeenCalled();
    expect(sentryNodeSdk.captureMessage).not.toHaveBeenCalled();
  });
});
