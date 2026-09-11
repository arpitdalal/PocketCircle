import { describe, expect, it } from "vitest";
import {
  DEFAULT_VAPID_KEY_ID,
  isValidPushEndpoint,
  isValidPushSubscriptionMaterial,
  MAX_PUSH_SUBSCRIPTIONS_PER_USER,
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

  it("requires non-empty keys with a valid endpoint", () => {
    expect(
      isValidPushSubscriptionMaterial({
        endpoint: "https://push.example/sub",
        p256dh: "key",
        auth: "auth",
      }),
    ).toBe(true);
    expect(
      isValidPushSubscriptionMaterial({
        endpoint: "https://push.example/sub",
        p256dh: "  ",
        auth: "auth",
      }),
    ).toBe(false);
  });
});
