import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  changelogSeenStorageKey,
  markChangelogVersionSeen,
  readChangelogSeenVersion,
  subscribeChangelogSeen,
  useChangelogUnread,
} from "./changelog-seen.js";

const ADA = "user-ada";
const GRACE = "user-grace";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Another same-origin tab marking a version seen for `userId`. */
function simulateOtherTabMarkedSeen(userId: string, version: string) {
  const key = changelogSeenStorageKey(userId);
  window.localStorage.setItem(key, version);
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: version }));
}

describe("changelog seen storage", () => {
  it("reads nothing before a first visit and round-trips a version", () => {
    expect(readChangelogSeenVersion(ADA)).toBeNull();

    markChangelogVersionSeen(ADA, "v1.4.0");

    expect(readChangelogSeenVersion(ADA)).toBe("v1.4.0");
    expect(window.localStorage.getItem(changelogSeenStorageKey(ADA))).toBe("v1.4.0");
  });

  it("keeps two Users on one browser isolated", () => {
    markChangelogVersionSeen(ADA, "v1.4.0");

    expect(readChangelogSeenVersion(GRACE)).toBeNull();
    expect(changelogSeenStorageKey(ADA)).not.toBe(changelogSeenStorageKey(GRACE));
  });

  // Safari private mode throws on write; "block all cookies" throws on read. The
  // indicator must still clear for this visit, and may return on the next one.
  it("keeps clearing the indicator when storage refuses to persist", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("SecurityError");
    });

    expect(() => markChangelogVersionSeen(ADA, "v1.4.0")).not.toThrow();
    expect(readChangelogSeenVersion(ADA)).toBe("v1.4.0");
    expect(renderHook(() => useChangelogUnread(ADA, "v1.4.0")).result.current).toBe(false);
  });

  // Under quota pressure ONLY the write fails, so the older persisted version stays
  // readable. Reading storage ahead of the session mirror would resurrect it and leave
  // the "New" badge stuck on a release the User has already read.
  it("prefers the version it could not persist over the older stored one", () => {
    markChangelogVersionSeen(ADA, "v1.4.0");
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });

    markChangelogVersionSeen(ADA, "v1.5.0");

    expect(readChangelogSeenVersion(ADA)).toBe("v1.5.0");
    expect(window.localStorage.getItem(changelogSeenStorageKey(ADA))).toBe("v1.4.0");
    expect(renderHook(() => useChangelogUnread(ADA, "v1.5.0")).result.current).toBe(false);
  });

  // The mirror is only this document's PENDING write. A tab that manages to persist a
  // newer version is authoritative, so the mirror has to step aside — otherwise this tab
  // would report the older pending version for the rest of its life.
  it("yields to a newer version another tab managed to persist", () => {
    markChangelogVersionSeen(ADA, "v1.4.0");
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    markChangelogVersionSeen(ADA, "v1.5.0");
    expect(readChangelogSeenVersion(ADA)).toBe("v1.5.0");

    setItem.mockRestore();
    simulateOtherTabMarkedSeen(ADA, "v1.6.0");

    expect(readChangelogSeenVersion(ADA)).toBe("v1.6.0");
    expect(renderHook(() => useChangelogUnread(ADA, "v1.6.0")).result.current).toBe(false);
  });

  // Same rule for a disappearing value: another tab clearing storage outranks a pending
  // write, so the mirror must not resurrect it.
  it("yields to another tab clearing the key", () => {
    markChangelogVersionSeen(ADA, "v1.4.0");
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    markChangelogVersionSeen(ADA, "v1.5.0");

    setItem.mockRestore();
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));

    expect(readChangelogSeenVersion(ADA)).toBeNull();
  });

  // Only a DIFFERENT stored value outranks the mirror. A tab on an older bundle can
  // re-write the very version the failed write read, which says nothing this document
  // does not already know — adopting it would re-raise "New" on a release the User read
  // here. Storage looks byte-identical either way, so nothing but the value can decide.
  it("keeps the pending version when another tab re-writes the one it failed over", () => {
    markChangelogVersionSeen(ADA, "v1.4.0");
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    markChangelogVersionSeen(ADA, "v1.5.0");
    setItem.mockRestore();

    const { result } = renderHook(() => useChangelogUnread(ADA, "v1.5.0"));
    expect(result.current).toBe(false);

    act(() => {
      simulateOtherTabMarkedSeen(ADA, "v1.4.0");
    });

    expect(readChangelogSeenVersion(ADA)).toBe("v1.5.0");
    expect(result.current).toBe(false);
  });

  // …but an observable gap does outrank it, wherever it lands afterwards: the clear is a
  // real cross-tab signal, so the mirror goes with it and the restore is just a new value.
  it("yields to a clear even when another tab restores the same version", () => {
    markChangelogVersionSeen(ADA, "v1.4.0");
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    markChangelogVersionSeen(ADA, "v1.5.0");
    setItem.mockRestore();

    const { result } = renderHook(() => useChangelogUnread(ADA, "v1.5.0"));
    act(() => {
      window.localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    act(() => {
      simulateOtherTabMarkedSeen(ADA, "v1.4.0");
    });

    expect(readChangelogSeenVersion(ADA)).toBe("v1.4.0");
    expect(result.current).toBe(true);
  });
});

describe("subscribeChangelogSeen", () => {
  it("notifies same-document writers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeChangelogSeen(listener);

    markChangelogVersionSeen(ADA, "v1.4.0");

    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    markChangelogVersionSeen(ADA, "v1.5.0");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("notifies on another tab's write", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeChangelogSeen(listener);

    simulateOtherTabMarkedSeen(ADA, "v1.4.0");

    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("ignores unrelated storage keys", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeChangelogSeen(listener);

    window.dispatchEvent(new StorageEvent("storage", { key: "some.other.key", newValue: "x" }));

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("useChangelogUnread", () => {
  it("is unread on a first visit and clears once the version is marked seen", () => {
    const { result } = renderHook(() => useChangelogUnread(ADA, "v1.4.0"));
    expect(result.current).toBe(true);

    act(() => {
      markChangelogVersionSeen(ADA, "v1.4.0");
    });

    expect(result.current).toBe(false);
  });

  it("becomes unread again when a newer version is released", () => {
    markChangelogVersionSeen(ADA, "v1.4.0");

    expect(renderHook(() => useChangelogUnread(ADA, "v1.4.0")).result.current).toBe(false);
    expect(renderHook(() => useChangelogUnread(ADA, "v1.5.0")).result.current).toBe(true);
  });

  it("does not share read state between Users", () => {
    markChangelogVersionSeen(ADA, "v1.4.0");

    expect(renderHook(() => useChangelogUnread(GRACE, "v1.4.0")).result.current).toBe(true);
  });

  // The archive opens in a new tab; the original app tab must drop its indicator.
  it("clears when another tab marks the version seen", () => {
    const { result } = renderHook(() => useChangelogUnread(ADA, "v1.4.0"));
    expect(result.current).toBe(true);

    act(() => {
      simulateOtherTabMarkedSeen(ADA, "v1.4.0");
    });

    expect(result.current).toBe(false);
  });

  it("reports read while the parser has no released version", () => {
    expect(renderHook(() => useChangelogUnread(ADA, undefined)).result.current).toBe(false);
  });
});
