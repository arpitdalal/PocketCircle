import { describe, expect, it } from "vitest";
import {
  DEFAULT_VAPID_KEY_ID,
  isTrustedPushEndpoint,
  isValidPushEndpoint,
  isValidPushSubscriptionMaterial,
  MAX_PUSH_SUBSCRIPTIONS_PER_USER,
} from "./push-subscriptions.js";

/** Synthetic valid key material for domain unit tests only. */
const TEST_P256DH =
  "BAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const TEST_AUTH = "CQkJCQkJCQkJCQkJCQkJCQ";
const TRUSTED_ENDPOINT = "https://fcm.googleapis.com/fcm/send/test-sub";

describe("push-subscriptions", () => {
  it("caps each User at ten subscriptions", () => {
    expect(MAX_PUSH_SUBSCRIPTIONS_PER_USER).toBe(10);
  });

  it("defaults VAPID key id to primary", () => {
    expect(DEFAULT_VAPID_KEY_ID).toBe("primary");
  });

  it("accepts https endpoints and rejects others", () => {
    expect(isValidPushEndpoint(TRUSTED_ENDPOINT)).toBe(true);
    expect(isValidPushEndpoint("http://insecure.example/push")).toBe(false);
    expect(isValidPushEndpoint("")).toBe(false);
    expect(isValidPushEndpoint("not-a-url")).toBe(false);
  });

  it("trusts known push-service hosts only", () => {
    expect(isTrustedPushEndpoint(TRUSTED_ENDPOINT)).toBe(true);
    expect(isTrustedPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(
      true,
    );
    expect(isTrustedPushEndpoint("https://evil.example/collect")).toBe(false);
    expect(isTrustedPushEndpoint("https://127.0.0.1/push")).toBe(false);
  });

  it("requires decoded key shapes usable by web-push", () => {
    expect(
      isValidPushSubscriptionMaterial({
        endpoint: TRUSTED_ENDPOINT,
        p256dh: TEST_P256DH,
        auth: TEST_AUTH,
      }),
    ).toBe(true);
    expect(
      isValidPushSubscriptionMaterial({
        endpoint: TRUSTED_ENDPOINT,
        p256dh: "key",
        auth: "auth",
      }),
    ).toBe(false);
    expect(
      isValidPushSubscriptionMaterial({
        endpoint: "https://evil.example/sub",
        p256dh: TEST_P256DH,
        auth: TEST_AUTH,
      }),
    ).toBe(false);
  });
});
