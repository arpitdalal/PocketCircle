import { describe, expect, it } from "vitest";
import { TEST_PUSH_P256DH } from "./push-test-fixtures.js";
import { isValidVapidPublicKey, tryDecodeVapidKeyBytes } from "./vapid-keys.js";

/** 65-byte 0x04 blob that is not a P-256 point. */
const OFF_CURVE_VAPID =
  "BAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";

describe("tryDecodeVapidKeyBytes", () => {
  it("returns null for malformed base64url", () => {
    expect(tryDecodeVapidKeyBytes("!!!not-base64!!!")).toBeNull();
    expect(tryDecodeVapidKeyBytes("")).toBeNull();
    expect(tryDecodeVapidKeyBytes("has spaces")).toBeNull();
  });

  it("decodes a short valid base64url payload", () => {
    expect(tryDecodeVapidKeyBytes("AQID")).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("isValidVapidPublicKey", () => {
  it("rejects short or wrong-prefix keys", () => {
    expect(isValidVapidPublicKey("AQID")).toBe(false);
    expect(isValidVapidPublicKey("BPtestPublicKey")).toBe(false);
  });

  it("rejects length-valid off-curve points", () => {
    expect(isValidVapidPublicKey(OFF_CURVE_VAPID)).toBe(false);
  });

  it("accepts an on-curve uncompressed P-256 public key", () => {
    expect(isValidVapidPublicKey(TEST_PUSH_P256DH)).toBe(true);
  });
});
