import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simulateCrossTabLastUsedGoogleEmailClear } from "~/test/last-used-google-email.js";
import {
  clearLastUsedGoogleEmail,
  getLastUsedGoogleEmail,
  getMaskedLastUsedGoogleEmail,
  LAST_USED_GOOGLE_EMAIL_STORAGE_KEY,
  maskGoogleAccountEmail,
  setLastUsedGoogleEmail,
  subscribeLastUsedGoogleEmail,
} from "./last-used-google-email.js";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("maskGoogleAccountEmail", () => {
  it.each([
    ["a@gmail.com", "a***@gmail.com"],
    ["ab@gmail.com", "ab***@gmail.com"],
    ["abc@gmail.com", "ab***@gmail.com"],
    ["alice@gmail.com", "al***e@gmail.com"],
    ["arpitdalalm@gmail.com", "ar***m@gmail.com"],
    ["bob@company.co.uk", "bo***@company.co.uk"],
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

describe("subscribeLastUsedGoogleEmail", () => {
  it("notifies subscribers when storage is cleared in another tab", () => {
    setLastUsedGoogleEmail("alice@gmail.com");
    const listener = vi.fn();
    const unsubscribe = subscribeLastUsedGoogleEmail(listener);

    simulateCrossTabLastUsedGoogleEmailClear("alice@gmail.com");

    expect(listener).toHaveBeenCalledOnce();
    expect(getMaskedLastUsedGoogleEmail()).toBeNull();
    unsubscribe();
  });

  it("notifies subscribers on same-tab clear", () => {
    setLastUsedGoogleEmail("alice@gmail.com");
    const listener = vi.fn();
    const unsubscribe = subscribeLastUsedGoogleEmail(listener);

    clearLastUsedGoogleEmail();

    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
});
