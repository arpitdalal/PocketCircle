import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearLastUsedGoogleEmail,
  getLastUsedGoogleEmail,
  LAST_USED_GOOGLE_EMAIL_STORAGE_KEY,
  maskGoogleAccountEmail,
  setLastUsedGoogleEmail,
} from "./last-used-google-email.js";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("maskGoogleAccountEmail", () => {
  it.each([
    ["alice@gmail.com", "a***@gmail.com"],
    ["bob@company.co.uk", "b***@company.co.uk"],
  ])("masks %s as %s", (email, masked) => {
    expect(maskGoogleAccountEmail(email)).toBe(masked);
  });

  it("returns null for malformed addresses", () => {
    expect(maskGoogleAccountEmail("@gmail.com")).toBeNull();
    expect(maskGoogleAccountEmail("alice@")).toBeNull();
    expect(maskGoogleAccountEmail("")).toBeNull();
  });
});

describe("last-used Google email storage", () => {
  it("round-trips a valid email", () => {
    setLastUsedGoogleEmail("alice@gmail.com");
    expect(getLastUsedGoogleEmail()).toBe("alice@gmail.com");
    clearLastUsedGoogleEmail();
    expect(getLastUsedGoogleEmail()).toBeNull();
  });

  it("does not write invalid emails", () => {
    setLastUsedGoogleEmail("not-an-email");
    expect(window.localStorage.getItem(LAST_USED_GOOGLE_EMAIL_STORAGE_KEY)).toBeNull();
  });

  it("clears corrupt storage on read", () => {
    window.localStorage.setItem(LAST_USED_GOOGLE_EMAIL_STORAGE_KEY, "bad-value");
    expect(getLastUsedGoogleEmail()).toBeNull();
    expect(window.localStorage.getItem(LAST_USED_GOOGLE_EMAIL_STORAGE_KEY)).toBeNull();
  });
});
