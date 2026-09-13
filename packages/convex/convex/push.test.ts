// @vitest-environment node

import { pushBodyForNotificationType } from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mutateAndDrain, mutateAndDrainRetries } from "../test/mutateAndDrain.js";
import { listNotificationsForUser } from "../test/notifications.js";
import { listPushSubscriptionsForUser, seedPushSubscription } from "../test/pushSubscriptions.js";
import { registerPushWorkpool } from "../test/registerPushWorkpool.js";
import { makeUser, seedCircle, seedInvitation } from "../test/seed.js";
import { internal } from "./_generated/api.js";
import { PUSH_RETRY_BEHAVIOR } from "./push.js";
import { classifyPushHttpStatus, pushHttpStatusFromError } from "./pushFailure.js";
import { sendWebPushNotification } from "./pushSend.js";
import schema from "./schema.js";

const { mockSendNotification } = vi.hoisted(() => ({
  mockSendNotification: vi.fn(),
}));

vi.mock("web-push", () => ({
  default: {
    sendNotification: (...args: unknown[]) => mockSendNotification(...args),
  },
}));

const modules = import.meta.glob("./**/*.ts");

const ENDPOINT_A = "https://push.example.test/sub/a";
const ENDPOINT_B = "https://push.example.test/sub/b";

function stubVapidEnv(opts?: { keyId?: string }) {
  vi.stubEnv("VAPID_PUBLIC_KEY", "test-public-key");
  vi.stubEnv("VAPID_PRIVATE_KEY", "test-private-key");
  vi.stubEnv("VAPID_SUBJECT", "mailto:push@pocketcircle.test");
  vi.stubEnv("VAPID_KEY_ID", opts?.keyId ?? "primary");
}

beforeEach(() => {
  mockSendNotification.mockReset();
  mockSendNotification.mockResolvedValue({ statusCode: 201 });
  vi.unstubAllEnvs();
  stubVapidEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function seedRecipientWithSubs(
  t: ReturnType<typeof convexTest>,
  endpoints: string[],
  vapidKeyId = "primary",
) {
  const { owner, circleId } = await t.run((ctx) => seedCircle(ctx));
  const recipient = await t.run((ctx) => makeUser(ctx, "recipient@example.com", "Recipient"));
  for (const endpoint of endpoints) {
    await t.run((ctx) =>
      seedPushSubscription(ctx, {
        userId: recipient._id,
        endpoint,
        vapidKeyId,
      }),
    );
  }
  return { owner, circleId, recipient };
}

describe("classifyPushHttpStatus", () => {
  it("treats 404 and 410 as gone", () => {
    expect(classifyPushHttpStatus(404)).toBe("gone");
    expect(classifyPushHttpStatus(410)).toBe("gone");
    expect(classifyPushHttpStatus(500)).toBe("transient");
    expect(classifyPushHttpStatus(429)).toBe("transient");
  });

  it("reads statusCode from web-push errors", () => {
    expect(pushHttpStatusFromError({ statusCode: 410 })).toBe(410);
    expect(pushHttpStatusFromError(new Error("network"))).toBeUndefined();
  });
});

describe("Push mirror from Notification Center", () => {
  it("enqueues one send per active subscription with safe copy, tag, TTL, and key", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A, ENDPOINT_B]);

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: recipient._id,
        actorUserId: owner._id,
        type: "transaction.paid_by",
        title: "Paid By updated",
        body: "Ada set you as Paid By on Weekly shop.",
        link: "/circles/family-c123/transactions/shop-t456",
      }),
    );

    expect(mockSendNotification).toHaveBeenCalledTimes(2);

    const rows = await t.run((ctx) => listNotificationsForUser(ctx, recipient._id));
    expect(rows).toHaveLength(1);
    const notificationId = rows[0]?._id;
    expect(notificationId).toBeTruthy();

    const payloads = mockSendNotification.mock.calls.map((call) => {
      const subscription = call[0];
      const body = call[1];
      const options = call[2];
      if (typeof body !== "string" || typeof options !== "object" || options === null) {
        throw new Error("unexpected web-push args");
      }
      const parsed = JSON.parse(body);
      return {
        endpoint:
          typeof subscription === "object" &&
          subscription !== null &&
          "endpoint" in subscription &&
          typeof subscription.endpoint === "string"
            ? subscription.endpoint
            : undefined,
        parsed,
        options,
      };
    });

    const endpoints = payloads.map((p) => p.endpoint).sort();
    expect(endpoints).toEqual([ENDPOINT_A, ENDPOINT_B].sort());

    for (const payload of payloads) {
      expect(payload.parsed).toEqual({
        title: "Paid By updated",
        body: pushBodyForNotificationType("transaction.paid_by"),
        tag: notificationId,
      });
      expect(payload.parsed.body).not.toMatch(/Ada|Weekly shop|family/i);
      expect(payload.options).toMatchObject({
        TTL: 24 * 60 * 60,
        vapidDetails: {
          subject: "mailto:push@pocketcircle.test",
          publicKey: "test-public-key",
          privateKey: "test-private-key",
        },
      });
    }
  });

  it("caps invitation Push TTL at the invitation deadline", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    const { owner, circleId, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A]);
    const expiresAt = Date.now() + 2 * 60 * 60 * 1000;
    const invitationId = await t.run(async (ctx) => {
      return await seedInvitation(ctx, circleId, owner._id, {
        email: recipient.email,
        expiresAt,
      });
    });

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: recipient._id,
        actorUserId: owner._id,
        type: "invitation.received",
        title: "Circle invitation",
        body: "You've been invited to Family.",
        link: `/invitations/family-${invitationId}`,
      }),
    );

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    const options = mockSendNotification.mock.calls[0]?.[2];
    expect(options).toMatchObject({
      TTL: expect.any(Number),
    });
    const ttl =
      typeof options === "object" && options !== null && "TTL" in options ? options.TTL : undefined;
    expect(typeof ttl).toBe("number");
    expect(ttl).toBeGreaterThan(7000);
    expect(ttl).toBeLessThanOrEqual(2 * 60 * 60);
  });

  it("prunes the subscription on 410 without retrying", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A]);
    mockSendNotification.mockRejectedValue({ statusCode: 410, body: "Gone" });

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: recipient._id,
        actorUserId: owner._id,
        type: "circle.archived",
        title: "Circle archived",
        body: "Ada archived Family.",
      }),
    );

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    const remaining = await t.run((ctx) => listPushSubscriptionsForUser(ctx, recipient._id));
    expect(remaining).toHaveLength(0);
    const rows = await t.run((ctx) => listNotificationsForUser(ctx, recipient._id));
    expect(rows).toHaveLength(1);
  });

  it("retries transient failures then reports exhaustion", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A]);
    mockSendNotification.mockRejectedValue({ statusCode: 500, body: "Unavailable" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mutateAndDrainRetries(
      t,
      () =>
        t.mutation(internal.notify.deliverOne, {
          recipientUserId: recipient._id,
          actorUserId: owner._id,
          type: "circle.restored",
          title: "Circle restored",
        }),
      PUSH_RETRY_BEHAVIOR,
    );

    expect(mockSendNotification.mock.calls.length).toBe(PUSH_RETRY_BEHAVIOR.maxAttempts);
    const rows = await t.run((ctx) => listNotificationsForUser(ctx, recipient._id));
    expect(rows).toHaveLength(1);
    expect(errSpy).toHaveBeenCalledWith(
      "Push delivery exhausted all retries",
      expect.any(String),
      expect.any(String),
    );
    errSpy.mockRestore();
  });

  it("isolates per-subscription failure — other devices still send", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A, ENDPOINT_B]);
    mockSendNotification.mockImplementation(async (subscription: { endpoint: string }) => {
      if (subscription.endpoint === ENDPOINT_A) {
        throw { statusCode: 410, body: "Gone" };
      }
      return { statusCode: 201 };
    });

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: recipient._id,
        actorUserId: owner._id,
        type: "member.removed",
        title: "Removed from Circle",
      }),
    );

    expect(mockSendNotification).toHaveBeenCalledTimes(2);
    const remaining = await t.run((ctx) => listPushSubscriptionsForUser(ctx, recipient._id));
    expect(remaining.map((row) => row.endpoint)).toEqual([ENDPOINT_B]);
  });

  it("skips send when vapidKeyId does not match configured key", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    stubVapidEnv({ keyId: "primary" });
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A], "legacy");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: recipient._id,
        actorUserId: owner._id,
        type: "category.archived",
        title: "Category archived",
      }),
    );

    expect(mockSendNotification).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      "VAPID env not configured or key id mismatch; skipping push send",
    );
    errSpy.mockRestore();
  });

  it("keeps the NC row when Push env is unset", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    vi.unstubAllEnvs();
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: recipient._id,
        actorUserId: owner._id,
        type: "ownership.transferred",
        title: "Ownership transferred",
      }),
    );

    expect(mockSendNotification).not.toHaveBeenCalled();
    const rows = await t.run((ctx) => listNotificationsForUser(ctx, recipient._id));
    expect(rows).toHaveLength(1);
    errSpy.mockRestore();
  });
});

describe("sendWebPushNotification", () => {
  it("forwards subscription, payload, TTL, and VAPID details to web-push", async () => {
    await sendWebPushNotification({
      endpoint: ENDPOINT_A,
      p256dh: "p256",
      auth: "auth",
      payload: { title: "T", body: "B", tag: "tag-1" },
      ttlSeconds: 120,
      vapidDetails: {
        subject: "mailto:x@y.z",
        publicKey: "pub",
        privateKey: "priv",
      },
    });

    expect(mockSendNotification).toHaveBeenCalledWith(
      {
        endpoint: ENDPOINT_A,
        keys: { p256dh: "p256", auth: "auth" },
      },
      JSON.stringify({ title: "T", body: "B", tag: "tag-1" }),
      {
        TTL: 120,
        vapidDetails: {
          subject: "mailto:x@y.z",
          publicKey: "pub",
          privateKey: "priv",
        },
        topic: "tag-1",
      },
    );
  });
});
