import { describe, expect, it } from "vitest";
import { isValidVapidPublicKey, tryDecodeVapidKeyBytes } from "./vapid-keys.js";

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

  it("accepts an uncompressed P-256 public key", () => {
    // 65 bytes starting with 0x04, URL-safe base64.
    const bytes = new Uint8Array(65);
    bytes[0] = 0x04;
    for (let i = 1; i < 65; i += 1) {
      bytes[i] = i;
    }
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    const key = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(isValidVapidPublicKey(key)).toBe(true);
  });
});
