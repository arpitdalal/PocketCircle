import { describe, expect, it } from "vitest";
import {
  DEFAULT_VAPID_KEY_ID,
  isPrivateOrReservedIpAddress,
  isSafePushEndpoint,
  isValidPushEndpoint,
  isValidPushSubscriptionMaterial,
  MAX_PUSH_SUBSCRIPTIONS_PER_USER,
} from "./push-subscriptions.js";
import { TEST_PUSH_AUTH, TEST_PUSH_P256DH } from "./push-test-fixtures.js";

const PUBLIC_ENDPOINT = "https://fcm.googleapis.com/fcm/send/test-sub";
/** 65-byte 0x04 blob that is not a P-256 point. */
const OFF_CURVE_P256DH =
  "BAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";

describe("push-subscriptions", () => {
  it("caps each User at ten subscriptions", () => {
    expect(MAX_PUSH_SUBSCRIPTIONS_PER_USER).toBe(10);
  });

  it("defaults VAPID key id to primary", () => {
    expect(DEFAULT_VAPID_KEY_ID).toBe("primary");
  });

  it("accepts https endpoints and rejects others", () => {
    expect(isValidPushEndpoint(PUBLIC_ENDPOINT)).toBe(true);
    expect(isValidPushEndpoint("http://insecure.example/push")).toBe(false);
    expect(isValidPushEndpoint("")).toBe(false);
    expect(isValidPushEndpoint("not-a-url")).toBe(false);
  });

  it("allows opaque public push hosts and rejects private destinations", () => {
    expect(isSafePushEndpoint(PUBLIC_ENDPOINT)).toBe(true);
    expect(isSafePushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isSafePushEndpoint("https://push.example-browser.test/wpush/v2/x")).toBe(true);
    expect(isSafePushEndpoint("https://127.0.0.1/push")).toBe(false);
    expect(isSafePushEndpoint("https://localhost/push")).toBe(false);
    expect(isSafePushEndpoint("https://localhost./push")).toBe(false);
    expect(isSafePushEndpoint("https://host.local/push")).toBe(false);
    expect(isSafePushEndpoint("https://[::1]/push")).toBe(false);
  });

  it("classifies private and reserved IP addresses", () => {
    expect(isPrivateOrReservedIpAddress("10.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIpAddress("192.168.1.1")).toBe(true);
    expect(isPrivateOrReservedIpAddress("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIpAddress("169.254.169.254")).toBe(true);
    expect(isPrivateOrReservedIpAddress("198.18.0.1")).toBe(true);
    expect(isPrivateOrReservedIpAddress("100.64.0.1")).toBe(true);
    expect(isPrivateOrReservedIpAddress("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIpAddress("::1")).toBe(true);
    expect(isPrivateOrReservedIpAddress("2001:4860:4860::8888")).toBe(false);
    expect(isPrivateOrReservedIpAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIpAddress("::ffff:7f00:1")).toBe(true);
    expect(isPrivateOrReservedIpAddress("::ffff:0808:0808")).toBe(false);
  });

  it("requires decoded key shapes usable by web-push", () => {
    expect(
      isValidPushSubscriptionMaterial({
        endpoint: PUBLIC_ENDPOINT,
        p256dh: TEST_PUSH_P256DH,
        auth: TEST_PUSH_AUTH,
      }),
    ).toBe(true);
    expect(
      isValidPushSubscriptionMaterial({
        endpoint: PUBLIC_ENDPOINT,
        p256dh: "key",
        auth: "auth",
      }),
    ).toBe(false);
    expect(
      isValidPushSubscriptionMaterial({
        endpoint: "https://127.0.0.1/sub",
        p256dh: TEST_PUSH_P256DH,
        auth: TEST_PUSH_AUTH,
      }),
    ).toBe(false);
    // Compressed 33-byte points are not valid for RFC 8291 user-agent keys.
    const compressed = Buffer.alloc(33, 2).toString("base64url");
    expect(
      isValidPushSubscriptionMaterial({
        endpoint: PUBLIC_ENDPOINT,
        p256dh: compressed,
        auth: TEST_PUSH_AUTH,
      }),
    ).toBe(false);
    // Length-valid but off-curve points must not bind.
    expect(
      isValidPushSubscriptionMaterial({
        endpoint: PUBLIC_ENDPOINT,
        p256dh: OFF_CURVE_P256DH,
        auth: TEST_PUSH_AUTH,
      }),
    ).toBe(false);
  });
});
