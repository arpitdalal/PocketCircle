import { describe, expect, it } from "vitest";
import {
  DEFAULT_VAPID_KEY_ID,
  isValidPushEndpoint,
  isValidPushSubscriptionMaterial,
  MAX_PUSH_SUBSCRIPTIONS_PER_USER,
  TEST_PUSH_AUTH,
  TEST_PUSH_P256DH,
} from "./push-subscriptions.js";

describe("push-subscriptions", () => {
  it("caps each User at ten subscriptions", () => {
    expect(MAX_PUSH_SUBSCRIPTIONS_PER_USER).toBe(10);
  });

  it("defaults VAPID key id to primary", () => {
    expect(DEFAULT_VAPID_KEY_ID).toBe("primary");
  });

  it("accepts https endpoints and rejects others", () => {
    expect(isValidPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isValidPushEndpoint("http://insecure.example/push")).toBe(false);
    expect(isValidPushEndpoint("")).toBe(false);
    expect(isValidPushEndpoint("not-a-url")).toBe(false);
  });

  it("requires decoded key shapes usable by web-push", () => {
    expect(
      isValidPushSubscriptionMaterial({
        endpoint: "https://push.example/sub",
        p256dh: TEST_PUSH_P256DH,
        auth: TEST_PUSH_AUTH,
      }),
    ).toBe(true);
    expect(
      isValidPushSubscriptionMaterial({
        endpoint: "https://push.example/sub",
        p256dh: "key",
        auth: "auth",
      }),
    ).toBe(false);
    expect(
      isValidPushSubscriptionMaterial({
        endpoint: "https://push.example/sub",
        p256dh: "  ",
        auth: TEST_PUSH_AUTH,
      }),
    ).toBe(false);
  });
});
