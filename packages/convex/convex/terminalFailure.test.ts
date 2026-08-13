import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mutateAndDrain } from "../test/mutateAndDrain.js";
import { seedFeedbackEmailEvent, seedInvitation, seedPersonalCircleOwner } from "../test/seed.js";
import { enableSentryReporting, sentryNodeSdk } from "../test/sentry-boundary.js";
import { internal } from "./_generated/api.js";
import { hashInvitationToken } from "./invitationToken.js";
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

function capturedEvent() {
  expect(sentryNodeSdk.captureEvent).toHaveBeenCalledOnce();
  const [event] = sentryNodeSdk.captureEvent.mock.calls[0] ?? [];
  expect(event).toBeTypeOf("object");
  expect(event).not.toBeNull();
  return event;
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

    const event = capturedEvent();
    expect(event).toEqual({
      message: "welcome_email_exhausted",
      level: "error",
      release: "abc1234",
      tags: { failureKind: "welcome_email_exhausted" },
      extra: {
        entityId: userId,
        error: "Resend send failed: 503",
      },
    });
    expect(sentryNodeSdk.captureMessage).not.toHaveBeenCalled();
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

    const event = capturedEvent();
    expect(event).toMatchObject({
      message: "invitation_email_exhausted",
      extra: { entityId: invitationId },
    });
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

    const event = capturedEvent();
    expect(event).toMatchObject({
      message: "feedback_email_exhausted",
      extra: { entityId: eventId },
    });
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

    const event = capturedEvent();
    expect(event).toMatchObject({
      message: "account_deletion_email_exhausted",
      extra: { entityId: userId },
    });
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
    const event = capturedEvent();
    expect(event).toMatchObject({
      message: "account_deletion_cleanup_failed",
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

    expect(sentryNodeSdk.captureEvent).not.toHaveBeenCalled();
    expect(sentryNodeSdk.captureMessage).not.toHaveBeenCalled();
  });

  it("strips emails and invitation links from the reported error", async () => {
    enableSentryReporting();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = createTestConvex();
    const { userId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );
    const rawError =
      'Resend send failed: 401 {"to":"ada@example.com","url":"https://app.example.com/invite/secret-token"}';
    const sanitized = 'Resend send failed: 401 {"to":"[redacted-email]","url":"[redacted-url]"}';

    try {
      await mutateAndDrain(t, () =>
        t.mutation(internal.email.onWelcomeRunComplete, {
          workId: "work-pii",
          context: { userId },
          result: { kind: "failed", error: rawError },
        }),
      );

      const event = capturedEvent();
      expect(event).toMatchObject({ extra: { error: sanitized }, release: "abc1234" });
      expect(errSpy.mock.calls.flat().join(" ")).toContain(sanitized);
      expect(errSpy.mock.calls.flat().join(" ")).not.toContain("ada@example.com");
      expect(JSON.stringify(event)).not.toContain("ada@example.com");
      expect(JSON.stringify(event)).not.toContain("secret-token");
      expect(JSON.stringify(event)).not.toContain("Please add dark mode");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("attributes the Sentry event to the release snapshotted at failure time", async () => {
    enableSentryReporting();
    const t = createTestConvex();
    const { userId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );

    await mutateAndDrain(t, async () => {
      await t.mutation(internal.email.onWelcomeRunComplete, {
        workId: "work-stale-env",
        context: { userId },
        result: { kind: "failed", error: "Resend send failed: 503" },
      });
      vi.stubEnv("APP_RELEASE", "later789");
    });

    const event = capturedEvent();
    expect(event).toMatchObject({ release: "abc1234" });
    expect(sentryNodeSdk.initWithoutDefaultIntegrations).toHaveBeenCalledWith(
      expect.objectContaining({ release: "abc1234" }),
    );
    expect(JSON.stringify(event)).not.toContain("later789");
    expect(JSON.stringify(sentryNodeSdk.initWithoutDefaultIntegrations.mock.calls)).not.toContain(
      "later789",
    );
  });

  it("does not throw when Sentry capture itself fails", async () => {
    enableSentryReporting();
    sentryNodeSdk.captureEvent.mockImplementation(() => {
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
    expect(sentryNodeSdk.captureEvent).not.toHaveBeenCalled();
    expect(sentryNodeSdk.captureMessage).not.toHaveBeenCalled();
  });

  it("reports welcome send when Resend env is missing without failing the job", async () => {
    enableSentryReporting();
    const t = createTestConvex();
    const { userId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );

    await mutateAndDrain(t, () => t.action(internal.email.sendWelcomeEmail, { userId }));

    expect(capturedEvent()).toMatchObject({
      message: "welcome_email_exhausted",
      extra: { entityId: userId, error: "Resend env not configured" },
    });
  });

  it("reports invitation send when Resend env is missing without failing the job", async () => {
    enableSentryReporting();
    const t = createTestConvex();
    const token = "plaintext-invite-token";
    const invitationId = await t.run(async (ctx) => {
      const seed = await seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
      });
      return seedInvitation(ctx, seed.personalCircleId, seed.userId, {
        email: "grace@example.com",
        tokenHash: await hashInvitationToken(token),
      });
    });

    await mutateAndDrain(t, () =>
      t.action(internal.email.sendInvitationEmail, { invitationId, token, resendCount: 0 }),
    );

    expect(capturedEvent()).toMatchObject({
      message: "invitation_email_exhausted",
      extra: { entityId: invitationId, error: "Resend env not configured" },
    });
  });

  it("reports feedback send when SUPPORT_EMAIL is missing without failing the job", async () => {
    enableSentryReporting();
    const t = createTestConvex();
    const eventId = await t.run(async (ctx) => {
      const seed = await seedPersonalCircleOwner(ctx, {
        email: "ada@example.com",
        displayName: "Ada",
      });
      return seedFeedbackEmailEvent(ctx, { userId: seed.userId, type: "bug", sentAt: Date.now() });
    });

    await mutateAndDrain(t, () =>
      t.action(internal.email.sendFeedbackEmail, {
        eventId,
        type: "bug",
        message: "Please add dark mode",
        userEmail: "ada@example.com",
        displayName: "Ada",
        appVersion: "local-dev",
        submittedAtIso: "2026-08-13T00:00:00.000Z",
      }),
    );

    const event = capturedEvent();
    expect(event).toMatchObject({
      message: "feedback_email_exhausted",
      extra: { entityId: eventId, error: "SUPPORT_EMAIL not configured" },
    });
    expect(JSON.stringify(event)).not.toContain("Please add dark mode");
    expect(JSON.stringify(event)).not.toContain("ada@example.com");
  });

  it("reports account-deletion send when Resend env is missing without failing the job", async () => {
    enableSentryReporting();
    vi.stubEnv("SITE_URL", "https://app.example.com");
    const t = createTestConvex();
    const { userId } = await t.run((ctx) =>
      seedPersonalCircleOwner(ctx, { email: "ada@example.com", displayName: "Ada" }),
    );

    await mutateAndDrain(t, () =>
      t.action(internal.accountDeletion.sendAccountDeletionEmail, {
        userId,
        email: "ada@example.com",
        displayName: "Ada",
        token: "delete-token",
      }),
    );

    const event = capturedEvent();
    expect(event).toMatchObject({
      message: "account_deletion_email_exhausted",
      extra: { entityId: userId, error: "Resend env not configured" },
    });
    expect(JSON.stringify(event)).not.toContain("ada@example.com");
    expect(JSON.stringify(event)).not.toContain("delete-token");
  });
});
