// @vitest-environment node

import { promises as dns } from "node:dns";
import { pushBodyForNotificationType, pushTitleForNotificationType } from "@pocketcircle/domain";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mutateAndDrain, mutateAndDrainRetries } from "../test/mutateAndDrain.js";
import { listNotificationsForUser } from "../test/notifications.js";
import { generateTestVapidKeyPair } from "../test/pushFixtures.js";
import { listPushSubscriptionsForUser, seedPushSubscription } from "../test/pushSubscriptions.js";
import { registerPushWorkpool } from "../test/registerPushWorkpool.js";
import { makeUser, seedCircle } from "../test/seed.js";
import { internal } from "./_generated/api.js";
import { isPushDeliveryEnabled, PUSH_RETRY_BEHAVIOR } from "./push.js";
import { classifyPushHttpStatus, pushHttpStatusFromError } from "./pushFailure.js";
import {
  createPinnedHttpsAgent,
  endpointResolvesToPublicAddress,
  isLikelyInvalidSubscriptionCryptoError,
  isMatchingVapidKeyPair,
  isValidVapidSubject,
  PUSH_SEND_TIMEOUT_MS,
  pushTopicFromNotificationId,
  resolvePushEndpointAddresses,
  sendWebPushNotification,
} from "./pushSend.js";
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

const ENDPOINT_A = "https://fcm.googleapis.com/fcm/send/test-a";
const ENDPOINT_B = "https://fcm.googleapis.com/fcm/send/test-b";

/** Real ECDH pairs so env validation rejects mismatched length-valid keys. */
const PRIMARY_VAPID = generateTestVapidKeyPair();
const PREVIOUS_VAPID = generateTestVapidKeyPair();
const VAPID_PUBLIC = PRIMARY_VAPID.publicKey;
const VAPID_PRIVATE = PRIMARY_VAPID.privateKey;
const VAPID_PUBLIC_PREVIOUS = PREVIOUS_VAPID.publicKey;
const VAPID_PRIVATE_PREVIOUS = PREVIOUS_VAPID.privateKey;

function stubVapidEnv(opts?: {
  keyId?: string;
  subject?: string;
  publicKey?: string;
  privateKey?: string;
}) {
  vi.stubEnv("VAPID_PUBLIC_KEY", opts?.publicKey ?? VAPID_PUBLIC);
  vi.stubEnv("VAPID_PRIVATE_KEY", opts?.privateKey ?? VAPID_PRIVATE);
  vi.stubEnv("VAPID_SUBJECT", opts?.subject ?? "mailto:push@pocketcircle.test");
  vi.stubEnv("VAPID_KEY_ID", opts?.keyId ?? "primary");
  vi.stubEnv("PUSH_DELIVERY_ENABLED", "1");
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
  vi.restoreAllMocks();
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
  it("classifies gone, permanent, and transient statuses", () => {
    expect(classifyPushHttpStatus(404)).toBe("gone");
    expect(classifyPushHttpStatus(410)).toBe("gone");
    expect(classifyPushHttpStatus(400)).toBe("permanent");
    expect(classifyPushHttpStatus(403)).toBe("permanent");
    expect(classifyPushHttpStatus(408)).toBe("transient");
    expect(classifyPushHttpStatus(429)).toBe("transient");
    expect(classifyPushHttpStatus(500)).toBe("transient");
  });

  it("reads statusCode from web-push errors", () => {
    expect(pushHttpStatusFromError({ statusCode: 410 })).toBe(410);
    expect(pushHttpStatusFromError(new Error("network"))).toBeUndefined();
  });
});

describe("isLikelyInvalidSubscriptionCryptoError", () => {
  it("only matches encrypt failures that name subscription keys", () => {
    expect(isLikelyInvalidSubscriptionCryptoError(new Error("Unable to encrypt with p256dh"))).toBe(
      true,
    );
    expect(isLikelyInvalidSubscriptionCryptoError(new Error("auth encrypt failed"))).toBe(true);
    expect(
      isLikelyInvalidSubscriptionCryptoError(new Error("OpenSSL crypto asymmetric unsupported")),
    ).toBe(false);
    expect(isLikelyInvalidSubscriptionCryptoError(new Error("Invalid key for VAPID JWT"))).toBe(
      false,
    );
  });

  it("treats off-curve ECDH public key errors as invalid subscription crypto", () => {
    const err = Object.assign(new Error("Public key is not valid for specified curve"), {
      code: "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY",
    });
    expect(isLikelyInvalidSubscriptionCryptoError(err)).toBe(true);
    // Message alone must not prune — only the Node errno.
    expect(
      isLikelyInvalidSubscriptionCryptoError(
        new Error("Public key is not valid for specified curve"),
      ),
    ).toBe(false);
  });
});

describe("VAPID env validation", () => {
  it("accepts only parseable https/mailto subjects with a contact", () => {
    expect(isValidVapidSubject("mailto:push@pocketcircle.test")).toBe(true);
    expect(isValidVapidSubject("https://pocketcircle.app/contact")).toBe(true);
    expect(isValidVapidSubject("https:")).toBe(false);
    expect(isValidVapidSubject("mailto:")).toBe(false);
    expect(isValidVapidSubject("not-a-contact-uri")).toBe(false);
    expect(isValidVapidSubject("http://example.com")).toBe(false);
  });

  it("requires the public key to be derived from the private key", () => {
    expect(isMatchingVapidKeyPair(VAPID_PUBLIC, VAPID_PRIVATE)).toBe(true);
    expect(isMatchingVapidKeyPair(VAPID_PUBLIC, VAPID_PRIVATE_PREVIOUS)).toBe(false);
    expect(isMatchingVapidKeyPair(VAPID_PUBLIC_PREVIOUS, VAPID_PRIVATE)).toBe(false);
  });
});

describe("resolvePushEndpointAddresses", () => {
  it("rejects hosts that resolve to private addresses", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "10.0.0.8", family: 4 }]);
    await expect(
      resolvePushEndpointAddresses("https://push.attacker.test/wpush/v2/x"),
    ).resolves.toEqual({ kind: "unsafe" });
    await expect(
      endpointResolvesToPublicAddress("https://push.attacker.test/wpush/v2/x"),
    ).resolves.toBe(false);
  });

  it("accepts hosts that resolve to public addresses", async () => {
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    await expect(
      resolvePushEndpointAddresses("https://push.example-browser.test/wpush/v2/x"),
    ).resolves.toEqual({
      kind: "public",
      addresses: [{ address: "8.8.8.8", family: 4 }],
    });
  });

  it("reports lookup_failed on DNS errors (including ENOTFOUND) instead of unsafe", async () => {
    for (const code of ["EAI_AGAIN", "ENOTFOUND", "EAI_NONAME", "ENODATA", "EAI_NODATA"] as const) {
      const err = Object.assign(new Error(`getaddrinfo ${code}`), { code });
      vi.spyOn(dns, "lookup").mockRejectedValue(err);
      await expect(
        resolvePushEndpointAddresses("https://push.example-browser.test/wpush/v2/x"),
      ).resolves.toEqual({ kind: "lookup_failed", cause: err });
    }
  });
});

describe("createPinnedHttpsAgent", () => {
  it("lookup returns only the validated addresses", () => {
    const agent = createPinnedHttpsAgent([
      { address: "8.8.8.8", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ]);
    const lookup = agent.options.lookup;
    expect(lookup).toBeTypeOf("function");
    if (typeof lookup !== "function") {
      throw new Error("expected lookup");
    }
    let seen: { address: string; family: number } | undefined;
    lookup("push.example-browser.test", {}, (err, address, family) => {
      expect(err).toBeNull();
      if (typeof address !== "string" || typeof family !== "number") {
        throw new Error("expected single address");
      }
      seen = { address, family };
    });
    expect(seen).toEqual({ address: "8.8.8.8", family: 4 });
  });
});

describe("Push mirror from Notification Center", () => {
  it("skips enqueue when PUSH_DELIVERY_ENABLED is not 1", async () => {
    vi.stubEnv("PUSH_DELIVERY_ENABLED", "0");
    expect(isPushDeliveryEnabled()).toBe(false);
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A]);

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: recipient._id,
        actorUserId: owner._id,
        type: "circle.restored",
        title: "Circle restored",
      }),
    );

    expect(mockSendNotification).not.toHaveBeenCalled();
    const rows = await t.run((ctx) => listNotificationsForUser(ctx, recipient._id));
    expect(rows).toHaveLength(1);
  });

  it("enqueues one send per active subscription with safe copy, tag, TTL, and key", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A, ENDPOINT_B]);

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: recipient._id,
        actorUserId: owner._id,
        type: "transaction.paid_by",
        title: "Paid By updated — Ada Weekly shop",
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
        title: pushTitleForNotificationType("transaction.paid_by"),
        body: pushBodyForNotificationType("transaction.paid_by"),
        tag: notificationId,
      });
      expect(payload.parsed.title).not.toMatch(/Ada|Weekly shop/i);
      expect(payload.parsed.body).not.toMatch(/Ada|Weekly shop|family/i);
      expect(payload.options).toMatchObject({
        TTL: 24 * 60 * 60,
        topic: pushTopicFromNotificationId(notificationId ?? ""),
        timeout: 30_000,
        vapidDetails: {
          subject: "mailto:push@pocketcircle.test",
          publicKey: VAPID_PUBLIC,
          privateKey: VAPID_PRIVATE,
        },
      });
    }
  });

  it("caps invitation Push TTL at the invitation deadline", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A]);
    const expiresAt = Date.now() + 2 * 60 * 60 * 1000;

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: recipient._id,
        actorUserId: owner._id,
        type: "invitation.accepted",
        title: "Invitation accepted",
        body: "Ada joined Family.",
        invitationExpiresAt: expiresAt,
      }),
    );

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    const options = mockSendNotification.mock.calls[0]?.[2];
    const ttl =
      typeof options === "object" && options !== null && "TTL" in options ? options.TTL : undefined;
    expect(typeof ttl).toBe("number");
    expect(ttl).toBeGreaterThan(7000);
    expect(ttl).toBeLessThanOrEqual(2 * 60 * 60);
  });

  it("skips Push when the invitation deadline already passed", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A]);

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: recipient._id,
        actorUserId: owner._id,
        type: "invitation.received",
        title: "Circle invitation",
        invitationExpiresAt: Date.now() - 1_000,
      }),
    );

    expect(mockSendNotification).not.toHaveBeenCalled();
    const rows = await t.run((ctx) => listNotificationsForUser(ctx, recipient._id));
    expect(rows).toHaveLength(1);
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

  it("does not retry permanent 4xx failures and reports them", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A]);
    mockSendNotification.mockRejectedValue({ statusCode: 403, body: "Forbidden" });
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

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    const remaining = await t.run((ctx) => listPushSubscriptionsForUser(ctx, recipient._id));
    expect(remaining).toHaveLength(1);
    expect(errSpy).toHaveBeenCalledWith(
      "Push delivery exhausted all retries",
      expect.any(String),
      expect.stringContaining("permanent rejection: 403"),
    );
    errSpy.mockRestore();
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

  it("skips send when VAPID subject is malformed", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    stubVapidEnv({ subject: "https:" });
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: recipient._id,
        actorUserId: owner._id,
        type: "category.restored",
        title: "Category restored",
      }),
    );

    expect(mockSendNotification).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith("VAPID env malformed; skipping push send");
    errSpy.mockRestore();
  });

  it("skips send when VAPID public and private keys are not a pair", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    stubVapidEnv({ publicKey: VAPID_PUBLIC, privateKey: VAPID_PRIVATE_PREVIOUS });
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: recipient._id,
        actorUserId: owner._id,
        type: "category.restored",
        title: "Category restored",
      }),
    );

    expect(mockSendNotification).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith("VAPID env malformed; skipping push send");
    errSpy.mockRestore();
  });

  it("sends with the previous VAPID pair during rotation", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    stubVapidEnv({ keyId: "primary" });
    vi.stubEnv("VAPID_KEY_ID_PREVIOUS", "legacy");
    vi.stubEnv("VAPID_PUBLIC_KEY_PREVIOUS", VAPID_PUBLIC_PREVIOUS);
    vi.stubEnv("VAPID_PRIVATE_KEY_PREVIOUS", VAPID_PRIVATE_PREVIOUS);
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A], "legacy");

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: recipient._id,
        actorUserId: owner._id,
        type: "circle.archived",
        title: "Circle archived",
      }),
    );

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    expect(mockSendNotification.mock.calls[0]?.[2]).toMatchObject({
      vapidDetails: {
        publicKey: VAPID_PUBLIC_PREVIOUS,
        privateKey: VAPID_PRIVATE_PREVIOUS,
      },
    });
  });

  it("skips send when VAPID public key length is wrong", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    stubVapidEnv({ publicKey: "BPshortLookingButWrongLen" });
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A]);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: recipient._id,
        actorUserId: owner._id,
        type: "category.restored",
        title: "Category restored",
      }),
    );

    expect(mockSendNotification).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith("VAPID env malformed; skipping push send");
    errSpy.mockRestore();
  });

  it("does not prune when subscription material changed since the send snapshot", async () => {
    const t = convexTest(schema, modules);
    const { recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A]);
    const { TEST_PUSH_AUTH, TEST_PUSH_AUTH_ALT, TEST_PUSH_P256DH, TEST_PUSH_P256DH_ALT } =
      await import("../test/pushFixtures.js");
    const rows = await t.run((ctx) => listPushSubscriptionsForUser(ctx, recipient._id));
    const row = rows[0];
    if (!row) throw new Error("missing subscription");
    await t.run(async (ctx) => {
      await ctx.db.patch(row._id, {
        p256dh: TEST_PUSH_P256DH_ALT,
        auth: TEST_PUSH_AUTH_ALT,
      });
    });

    await t.mutation(internal.pushSubscriptions.removeInvalidPushSubscription, {
      subscriptionId: row._id,
      endpoint: ENDPOINT_A,
      p256dh: TEST_PUSH_P256DH,
      auth: TEST_PUSH_AUTH,
    });

    const remaining = await t.run((ctx) => listPushSubscriptionsForUser(ctx, recipient._id));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.p256dh).toBe(TEST_PUSH_P256DH_ALT);
  });

  it("prunes endpoints whose DNS resolves to a private address", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    const { owner, recipient } = await seedRecipientWithSubs(t, [
      "https://push.attacker.test/wpush/v2/x",
    ]);
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "10.0.0.8", family: 4 }]);

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: recipient._id,
        actorUserId: owner._id,
        type: "member.removed",
        title: "Removed from Circle",
      }),
    );

    expect(mockSendNotification).not.toHaveBeenCalled();
    const remaining = await t.run((ctx) => listPushSubscriptionsForUser(ctx, recipient._id));
    expect(remaining).toHaveLength(0);
  });

  it("retries transient DNS failures without pruning the subscription", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A]);
    const err = Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
    vi.spyOn(dns, "lookup").mockRejectedValue(err);

    await mutateAndDrainRetries(
      t,
      () =>
        t.mutation(internal.notify.deliverOne, {
          recipientUserId: recipient._id,
          actorUserId: owner._id,
          type: "member.removed",
          title: "Removed from Circle",
        }),
      PUSH_RETRY_BEHAVIOR,
    );

    expect(mockSendNotification).not.toHaveBeenCalled();
    const remaining = await t.run((ctx) => listPushSubscriptionsForUser(ctx, recipient._id));
    expect(remaining).toHaveLength(1);
  });

  it("pins validated DNS addresses into the web-push Agent", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A]);
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: recipient._id,
        actorUserId: owner._id,
        type: "member.removed",
        title: "Removed from Circle",
      }),
    );

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    const options = mockSendNotification.mock.calls[0]?.[2];
    expect(options).toEqual(
      expect.objectContaining({
        agent: expect.any(Object),
      }),
    );
  });

  it("prunes private destinations without calling web-push", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A]);
    await t.run(async (ctx) => {
      const rows = await listPushSubscriptionsForUser(ctx, recipient._id);
      const row = rows[0];
      if (!row) throw new Error("missing subscription");
      await ctx.db.patch(row._id, { endpoint: "https://127.0.0.1/collect" });
    });

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: recipient._id,
        actorUserId: owner._id,
        type: "member.removed",
        title: "Removed from Circle",
      }),
    );

    expect(mockSendNotification).not.toHaveBeenCalled();
    const remaining = await t.run((ctx) => listPushSubscriptionsForUser(ctx, recipient._id));
    expect(remaining).toHaveLength(0);
  });

  it("prunes the subscription on local encryption failure without retrying", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A]);
    mockSendNotification.mockRejectedValue(new Error("Unable to encrypt with p256dh"));

    await mutateAndDrain(t, () =>
      t.mutation(internal.notify.deliverOne, {
        recipientUserId: recipient._id,
        actorUserId: owner._id,
        type: "member.removed",
        title: "Removed from Circle",
      }),
    );

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    const remaining = await t.run((ctx) => listPushSubscriptionsForUser(ctx, recipient._id));
    expect(remaining).toHaveLength(0);
  });

  it("does not prune on generic crypto/VAPID runtime errors", async () => {
    const t = convexTest(schema, modules);
    registerPushWorkpool(t);
    const { owner, recipient } = await seedRecipientWithSubs(t, [ENDPOINT_A]);
    mockSendNotification.mockRejectedValue(new Error("OpenSSL crypto asymmetric unsupported"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await mutateAndDrainRetries(
      t,
      () =>
        t.mutation(internal.notify.deliverOne, {
          recipientUserId: recipient._id,
          actorUserId: owner._id,
          type: "member.removed",
          title: "Removed from Circle",
        }),
      PUSH_RETRY_BEHAVIOR,
    );

    expect(mockSendNotification.mock.calls.length).toBe(PUSH_RETRY_BEHAVIOR.maxAttempts);
    const remaining = await t.run((ctx) => listPushSubscriptionsForUser(ctx, recipient._id));
    expect(remaining).toHaveLength(1);
    expect(errSpy).toHaveBeenCalledWith(
      "Push delivery exhausted all retries",
      expect.any(String),
      expect.stringMatching(/OpenSSL crypto asymmetric unsupported/i),
    );
    errSpy.mockRestore();
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
    expect(errSpy).toHaveBeenCalledWith("VAPID key id mismatch; skipping push send");
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
  it("forwards subscription, payload, TTL, hashed topic, and VAPID details", async () => {
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
        topic: pushTopicFromNotificationId("tag-1"),
        timeout: PUSH_SEND_TIMEOUT_MS,
      },
    );
  });
});
