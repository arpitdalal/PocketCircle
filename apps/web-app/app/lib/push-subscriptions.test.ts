import { afterEach, describe, expect, it, vi } from "vitest";
import { deferredValue } from "~/lib/deferred.js";
import {
  applyPendingCleanupFlushResult,
  beginPushEnable,
  canRegisterPushServiceWorker,
  clearLocalPushSubscriptionAndBinding,
  clearPushEnableCancel,
  clearRememberedPushEndpoints,
  disableCurrentPushSubscription,
  endPushEnable,
  getCurrentPushSubscription,
  isPushEnableCancelRequested,
  PUSH_SERVICE_WORKER_URL,
  readPushSubscriptionMaterial,
  recalledPendingPushCleanup,
  recalledPushEndpoints,
  recordOrphanLocalDrop,
  registerPushServiceWorker,
  rememberPushEndpoint,
  rememberPushEndpoints,
  resetPushOperationState,
  resolvePushNotificationsCapability,
  subscribeForPushNotifications,
  unsubscribeLocalPushSubscription,
  vapidPublicKeyBytes,
  withPushSubscriptionLock,
} from "~/lib/push-subscriptions.js";
import { installPushEnv, makeFakePushSubscription, resetPushEnv } from "~/test/push-env.js";
import {
  installMatchMediaFake,
  resetNavigatorInstallProps,
  setNavigatorInstallProps,
} from "~/test/pwa-install-env.js";

const VAPID_PUBLIC_KEY = "AQID";
const VAPID = { publicKey: VAPID_PUBLIC_KEY, keyId: "primary" };

afterEach(() => {
  resetPushEnv();
  resetNavigatorInstallProps();
  clearRememberedPushEndpoints();
  resetPushOperationState();
  vi.clearAllMocks();
});

describe("registerPushServiceWorker", () => {
  it("registers the Push SW when allowed", async () => {
    const { register } = installPushEnv();
    expect(canRegisterPushServiceWorker(false)).toBe(true);
    await registerPushServiceWorker();
    expect(register).toHaveBeenCalledWith(PUSH_SERVICE_WORKER_URL);
  });

  it("skips registration when MOCKS is true", () => {
    installPushEnv();
    expect(canRegisterPushServiceWorker(true)).toBe(false);
  });
});

describe("resolvePushNotificationsCapability", () => {
  it("returns unsupported without Push APIs", () => {
    installPushEnv({ serviceWorker: false, pushManager: false, notification: false });
    expect(resolvePushNotificationsCapability()).toBe("unsupported");
  });

  it("returns needs_install on iOS browser tabs", () => {
    setNavigatorInstallProps({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      platform: "iPhone",
      maxTouchPoints: 5,
      standalone: undefined,
    });
    installMatchMediaFake(false);
    installPushEnv({ permission: "default" });
    expect(resolvePushNotificationsCapability()).toBe("needs_install");
  });

  it("returns needs_install on iOS even when Push APIs are absent", () => {
    setNavigatorInstallProps({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      platform: "iPhone",
      maxTouchPoints: 5,
      standalone: undefined,
    });
    installMatchMediaFake(false);
    installPushEnv({ serviceWorker: false, pushManager: false, notification: false });
    expect(resolvePushNotificationsCapability()).toBe("needs_install");
  });

  it("returns unsupported on pre-16.4 iOS instead of needs_install", () => {
    setNavigatorInstallProps({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X)",
      platform: "iPhone",
      maxTouchPoints: 5,
      standalone: undefined,
    });
    installMatchMediaFake(false);
    installPushEnv({ serviceWorker: false, pushManager: false, notification: false });
    expect(resolvePushNotificationsCapability()).toBe("unsupported");
  });

  it("returns needs_install on iOS 16.4", () => {
    setNavigatorInstallProps({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X)",
      platform: "iPhone",
      maxTouchPoints: 5,
      standalone: undefined,
    });
    installMatchMediaFake(false);
    installPushEnv({ permission: "default" });
    expect(resolvePushNotificationsCapability()).toBe("needs_install");
  });

  it("parses desktop-class iPadOS Version before promising Push", () => {
    setNavigatorInstallProps({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
      standalone: undefined,
    });
    installMatchMediaFake(false);
    installPushEnv({ serviceWorker: false, pushManager: false, notification: false });
    expect(resolvePushNotificationsCapability()).toBe("unsupported");
  });

  it("returns needs_install for desktop-class iPadOS 16.4+", () => {
    setNavigatorInstallProps({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
      standalone: undefined,
    });
    installMatchMediaFake(false);
    installPushEnv({ permission: "default" });
    expect(resolvePushNotificationsCapability()).toBe("needs_install");
  });

  it("returns blocked when permission is denied", () => {
    installPushEnv({ permission: "denied" });
    expect(resolvePushNotificationsCapability()).toBe("blocked");
  });

  it("returns default when capable and not blocked", () => {
    installPushEnv({ permission: "default" });
    expect(resolvePushNotificationsCapability()).toBe("default");
  });
});

describe("readPushSubscriptionMaterial", () => {
  it("unsubscribes on VAPID mismatch without resubscribing", async () => {
    const sub = makeFakePushSubscription({ endpoint: "https://push.example/old" });
    sub.options = { applicationServerKey: vapidPublicKeyBytes("BAQE") };
    const { subscribe } = installPushEnv({ permission: "granted", subscription: sub });

    await expect(readPushSubscriptionMaterial(VAPID)).resolves.toEqual({
      subscription: null,
      unboundEndpoint: "https://push.example/old",
      unboundEndpoints: ["https://push.example/old"],
    });
    expect(sub.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("does not unbind the server when VAPID unsubscribe fails", async () => {
    const sub = makeFakePushSubscription({ endpoint: "https://push.example/old" });
    sub.options = { applicationServerKey: vapidPublicKeyBytes("BAQE") };
    sub.unsubscribe = vi.fn().mockRejectedValue(new Error("unsubscribe failed"));
    installPushEnv({ permission: "granted", subscription: sub });

    await expect(readPushSubscriptionMaterial(VAPID)).resolves.toEqual({
      subscription: null,
    });
  });

  it("reports previousEndpoint when the browser refreshes the endpoint", async () => {
    const sub = makeFakePushSubscription({ endpoint: "https://push.example/new" });
    sub.options = { applicationServerKey: vapidPublicKeyBytes(VAPID_PUBLIC_KEY) };
    installPushEnv({ permission: "granted", subscription: sub });
    rememberPushEndpoint("https://push.example/old");

    await expect(readPushSubscriptionMaterial(VAPID)).resolves.toEqual({
      subscription: {
        endpoint: "https://push.example/new",
        p256dh: "p256dh-test",
        auth: "auth-test",
        vapidKeyId: "primary",
      },
      previousEndpoint: "https://push.example/old",
    });
    // Keep old endpoint remembered until replace succeeds.
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBe(
      "https://push.example/old",
    );
  });

  it("returns matching material without previousEndpoint when unchanged", async () => {
    const sub = makeFakePushSubscription({ endpoint: "https://push.example/same" });
    sub.options = { applicationServerKey: vapidPublicKeyBytes(VAPID_PUBLIC_KEY) };
    installPushEnv({ permission: "granted", subscription: sub });
    rememberPushEndpoint("https://push.example/same");

    await expect(readPushSubscriptionMaterial(VAPID)).resolves.toEqual({
      subscription: {
        endpoint: "https://push.example/same",
        p256dh: "p256dh-test",
        auth: "auth-test",
        vapidKeyId: "primary",
      },
    });
  });

  it("unbinds a remembered endpoint when the browser has no subscription", async () => {
    installPushEnv({ permission: "granted", subscription: null });
    rememberPushEndpoint("https://push.example/stale");

    await expect(readPushSubscriptionMaterial(VAPID)).resolves.toEqual({
      subscription: null,
      unboundEndpoint: "https://push.example/stale",
      unboundEndpoints: ["https://push.example/stale"],
    });
  });

  it("does not unbind remembered endpoints when subscription lookup fails", async () => {
    installPushEnv({
      permission: "granted",
      subscription: null,
      getSubscription: vi.fn().mockRejectedValue(new Error("lookup failed")),
    });
    rememberPushEndpoint("https://push.example/stale");

    await expect(readPushSubscriptionMaterial(VAPID)).resolves.toEqual({
      subscription: null,
    });
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBe(
      "https://push.example/stale",
    );
  });
});

describe("push operation serialization", () => {
  it("holds exclusive ownership beyond the old lease expiry and through failure cleanup", async () => {
    installPushEnv();
    const pending = deferredValue<void>();
    const started = deferredValue<void>();
    const operation = withPushSubscriptionLock(async () => {
      started.resolve();
      await pending.promise;
      throw new Error("transport failed");
    });
    const failed = expect(operation).rejects.toThrow("transport failed");
    await started.promise;
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(120_000);
    const competing = vi.fn(async () => {});
    await expect(withPushSubscriptionLock(competing)).rejects.toThrow(/another tab/);
    expect(competing).not.toHaveBeenCalled();
    pending.resolve();
    await failed;
    await withPushSubscriptionLock(competing);
    expect(competing).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});

describe("clearLocalPushSubscriptionAndBinding", () => {
  it("resolves when disable stalls past the sign-out timeout", async () => {
    vi.useFakeTimers();
    installPushEnv({
      permission: "granted",
      subscription: makeFakePushSubscription(),
    });
    const disable = vi.fn().mockImplementation(() => new Promise(() => {}));

    const done = clearLocalPushSubscriptionAndBinding(disable);
    await vi.advanceTimersByTimeAsync(5_000);
    const release = await done;
    release();
    vi.useRealTimers();
  });

  it("does not clear a later session after the sign-out cleanup times out", async () => {
    vi.useFakeTimers();
    const oldSub = makeFakePushSubscription({ endpoint: "https://push.example/old" });
    installPushEnv({ permission: "granted", subscription: oldSub });
    rememberPushEndpoint("https://push.example/old");

    let releaseDisable = () => {};
    const disable = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseDisable = () => resolve();
        }),
    );

    const done = clearLocalPushSubscriptionAndBinding(disable);
    await vi.advanceTimersByTimeAsync(5_000);
    const release = await done;

    // Later session enables Push before the stalled disable settles.
    const nextSub = makeFakePushSubscription({ endpoint: "https://push.example/next" });
    installPushEnv({ permission: "granted", subscription: nextSub });
    rememberPushEndpoint("https://push.example/next");

    releaseDisable();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    release();

    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBe(
      "https://push.example/next",
    );
    expect(nextSub.unsubscribe).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("unbinds remembered endpoints when live lookup fails on sign-out", async () => {
    installPushEnv({
      permission: "granted",
      subscription: null,
      getSubscription: vi.fn().mockRejectedValue(new Error("lookup failed")),
    });
    rememberPushEndpoint("https://push.example/remembered");
    const disable = vi.fn().mockResolvedValue({ removed: true });

    const release = await clearLocalPushSubscriptionAndBinding(disable);
    release();

    expect(disable).toHaveBeenCalledWith({ endpoint: "https://push.example/remembered" });
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBeNull();
  });

  it("keeps a timed-out unsubscribe locked and preserves its retry handle", async () => {
    vi.useFakeTimers();
    const pending = deferredValue<boolean>();
    const sub = makeFakePushSubscription();
    sub.unsubscribe.mockImplementation(() => pending.promise);
    const env = installPushEnv({ subscription: sub });
    const disable = vi.fn();
    const done = clearLocalPushSubscriptionAndBinding(disable);
    await vi.advanceTimersByTimeAsync(5_000);
    const release = await done;
    release();
    await expect(withPushSubscriptionLock(async () => {})).rejects.toThrow(/another tab/);
    expect(recalledPendingPushCleanup()).toContain(sub.endpoint);
    pending.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    await withPushSubscriptionLock(async () => {});
    expect(env.subscription).toBeNull();
    expect(disable).not.toHaveBeenCalled();
    expect(recalledPendingPushCleanup()).toContain(sub.endpoint);
    vi.useRealTimers();
  });

  it("waits for the active operation, then keeps the lock until sign-out settles", async () => {
    installPushEnv({ subscription: makeFakePushSubscription() });
    const pending = deferredValue<void>();
    const started = deferredValue<void>();
    const active = withPushSubscriptionLock(async () => {
      started.resolve();
      await pending.promise;
    });
    await started.promise;
    const disable = vi.fn().mockResolvedValue({ removed: true });
    const done = clearLocalPushSubscriptionAndBinding(disable);
    expect(isPushEnableCancelRequested()).toBe(true);
    expect(disable).not.toHaveBeenCalled();
    pending.resolve();
    await active;
    const release = await done;
    await expect(withPushSubscriptionLock(async () => {})).rejects.toThrow(/another tab/);
    release();
    await withPushSubscriptionLock(async () => {}, { wait: true });
    expect(disable).toHaveBeenCalled();
  });

  it("guards same-tab enable through sign-out when local storage is blocked", async () => {
    installPushEnv({ subscription: makeFakePushSubscription() });
    const storage = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    try {
      const release = await clearLocalPushSubscriptionAndBinding(
        vi.fn().mockResolvedValue({ removed: true }),
      );
      beginPushEnable();
      expect(isPushEnableCancelRequested()).toBe(true);
      endPushEnable();
      release();
      expect(isPushEnableCancelRequested()).toBe(false);
    } finally {
      storage.mockRestore();
    }
  });

  it("does not let another tab's begin clear cancel during sign-out cleanup", async () => {
    installPushEnv({
      permission: "granted",
      subscription: makeFakePushSubscription(),
    });
    window.localStorage.setItem("pocketcircle.pushSignOutCleanup.other", String(Date.now()));
    window.localStorage.setItem("pocketcircle.pushEnableCancel", String(Date.now()));

    beginPushEnable();
    expect(isPushEnableCancelRequested()).toBe(true);
    endPushEnable();
  });

  it("refuses to clear cancel when a cleanup mark is present", () => {
    window.localStorage.setItem("pocketcircle.pushSignOutCleanup.racer", String(Date.now()));
    window.localStorage.setItem("pocketcircle.pushEnableCancel", String(Date.now()));
    clearPushEnableCancel();
    expect(isPushEnableCancelRequested()).toBe(true);
  });

  it("restores cancel if a cleanup mark appears during clear", () => {
    const originalRemove = window.localStorage.removeItem.bind(window.localStorage);
    window.localStorage.removeItem = (key: string) => {
      originalRemove(key);
      if (key === "pocketcircle.pushEnableCancel") {
        window.localStorage.setItem(
          "pocketcircle.pushSignOutCleanup.during-clear",
          String(Date.now()),
        );
      }
    };
    try {
      window.localStorage.setItem("pocketcircle.pushEnableCancel", String(Date.now()));
      clearPushEnableCancel();
      expect(isPushEnableCancelRequested()).toBe(true);
    } finally {
      window.localStorage.removeItem = originalRemove;
    }
  });

  it("times out a queued cleanup without running it in a later session", async () => {
    vi.useFakeTimers();
    installPushEnv({ subscription: makeFakePushSubscription() });
    const pending = deferredValue<void>();
    const started = deferredValue<void>();
    const active = withPushSubscriptionLock(async () => {
      started.resolve();
      await pending.promise;
    });
    await started.promise;
    const disable = vi.fn();
    const done = clearLocalPushSubscriptionAndBinding(disable);
    await vi.advanceTimersByTimeAsync(5_000);
    const release = await done;
    release();
    pending.resolve();
    await active;
    expect(disable).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("heartbeats the sign-out guard past the crash TTL until release", async () => {
    vi.useFakeTimers();
    installPushEnv({
      permission: "granted",
      subscription: makeFakePushSubscription(),
    });
    const disable = vi.fn().mockResolvedValue({ removed: true });

    const releasePromise = clearLocalPushSubscriptionAndBinding(disable);
    await vi.advanceTimersByTimeAsync(5_000);
    const release = await releasePromise;

    // Without heartbeat the 60s TTL would sweep the mark/cancel.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(isPushEnableCancelRequested()).toBe(true);
    beginPushEnable();
    expect(isPushEnableCancelRequested()).toBe(true);
    endPushEnable();

    release();
    expect(isPushEnableCancelRequested()).toBe(false);
    vi.useRealTimers();
  });
});

describe("disableCurrentPushSubscription", () => {
  it("unbinds both live and remembered endpoints after a browser refresh", async () => {
    const sub = makeFakePushSubscription({ endpoint: "https://push.example/new" });
    installPushEnv({ permission: "granted", subscription: sub });
    rememberPushEndpoint("https://push.example/old");
    const disable = vi.fn().mockResolvedValue({ removed: true });

    await disableCurrentPushSubscription(disable);

    expect(sub.unsubscribe).toHaveBeenCalledOnce();
    expect(disable).toHaveBeenCalledWith({ endpoint: "https://push.example/new" });
    expect(disable).toHaveBeenCalledWith({ endpoint: "https://push.example/old" });
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBeNull();
  });

  it("retains a remembered endpoint when disable fails", async () => {
    const sub = makeFakePushSubscription({ endpoint: "https://push.example/new" });
    installPushEnv({ permission: "granted", subscription: sub });
    rememberPushEndpoint("https://push.example/old");
    const disable = vi
      .fn()
      .mockResolvedValueOnce({ removed: true })
      .mockRejectedValueOnce(new Error("server down"));

    await expect(disableCurrentPushSubscription(disable)).rejects.toThrow("server down");
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBeNull();
    expect(recalledPendingPushCleanup()).toEqual(["https://push.example/old"]);
  });

  it("keeps pending cleanup when disable does not remove a foreign binding", async () => {
    installPushEnv({ permission: "granted", subscription: null });
    rememberPushEndpoints(["https://push.example/alice-stale"]);
    const disable = vi.fn().mockResolvedValue({ removed: false });

    await expect(disableCurrentPushSubscription(disable)).resolves.toBeUndefined();
    expect(recalledPendingPushCleanup()).toEqual(["https://push.example/alice-stale"]);
  });

  it("does not fail a successful current-device disable for an unrelated retry", async () => {
    const sub = makeFakePushSubscription();
    installPushEnv({ subscription: sub });
    rememberPushEndpoint(sub.endpoint);
    rememberPushEndpoints(["https://push.example/foreign"]);
    const disable = vi.fn(async ({ endpoint }: { endpoint: string }) => ({
      removed: endpoint === sub.endpoint,
    }));
    await expect(disableCurrentPushSubscription(disable)).resolves.toBeUndefined();
    expect(recalledPendingPushCleanup()).toEqual(["https://push.example/foreign"]);
  });

  it("cannot overwrite another endpoint inserted during cleanup storage writes", () => {
    rememberPushEndpoints(["https://push.example/a", "https://push.example/b"]);
    const remove = window.localStorage.removeItem.bind(window.localStorage);
    const spy = vi.spyOn(window.localStorage, "removeItem").mockImplementation((key) => {
      remove(key);
      if (key.endsWith("https://push.example/a")) rememberPushEndpoints(["https://push.example/c"]);
    });
    try {
      applyPendingCleanupFlushResult(
        ["https://push.example/a", "https://push.example/b"],
        ["https://push.example/b"],
      );
      expect(recalledPendingPushCleanup()).toEqual([
        "https://push.example/b",
        "https://push.example/c",
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("retains every endpoint whose disable failed", async () => {
    const sub = makeFakePushSubscription({ endpoint: "https://push.example/new" });
    installPushEnv({ permission: "granted", subscription: sub });
    rememberPushEndpoint("https://push.example/old");
    const disable = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(disableCurrentPushSubscription(disable)).rejects.toThrow("offline");
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBeNull();
    expect(recalledPendingPushCleanup()).toEqual([
      "https://push.example/new",
      "https://push.example/old",
    ]);
  });

  it("keeps pending cleanup endpoints across re-enable", async () => {
    rememberPushEndpoints(["https://push.example/stale-a", "https://push.example/stale-b"]);
    installPushEnv({ permission: "granted", subscription: null });

    await subscribeForPushNotifications(VAPID);

    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBe(
      "https://push.example/test-endpoint",
    );
    expect(recalledPushEndpoints()).toEqual([
      "https://push.example/test-endpoint",
      "https://push.example/stale-a",
      "https://push.example/stale-b",
    ]);
    expect(recalledPendingPushCleanup()).toEqual([
      "https://push.example/stale-a",
      "https://push.example/stale-b",
    ]);
  });

  it("throws on lookup failure without sign-out fallback (Settings)", async () => {
    installPushEnv({
      permission: "granted",
      subscription: null,
      getSubscription: vi.fn().mockRejectedValue(new Error("lookup failed")),
    });
    rememberPushEndpoint("https://push.example/remembered");
    const disable = vi.fn().mockResolvedValue({ removed: true });

    await expect(disableCurrentPushSubscription(disable)).rejects.toThrow(
      "push subscription lookup failed",
    );
    expect(disable).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBe(
      "https://push.example/remembered",
    );
  });

  it("preserves the previous active endpoint when explicit enable replaces it", async () => {
    const sub = makeFakePushSubscription({ endpoint: "https://push.example/old-key" });
    sub.options = { applicationServerKey: vapidPublicKeyBytes("BAQE") };
    installPushEnv({ subscription: sub });
    rememberPushEndpoint(sub.endpoint);
    await subscribeForPushNotifications(VAPID);
    expect(recalledPendingPushCleanup()).toEqual([sub.endpoint]);
  });

  it("removes an endpoint from pending when it becomes active again", () => {
    rememberPushEndpoints(["https://push.example/a", "https://push.example/b"]);
    rememberPushEndpoint("https://push.example/a");
    expect(recalledPendingPushCleanup()).toEqual(["https://push.example/b"]);
  });

  it("preserves foreign orphan endpoints as pending cleanup", () => {
    rememberPushEndpoint("https://push.example/alice");
    recordOrphanLocalDrop("https://push.example/alice");
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBeNull();
    expect(recalledPendingPushCleanup()).toEqual(["https://push.example/alice"]);
  });

  it("merges pending cleanup flush results without wiping newer endpoints", () => {
    rememberPushEndpoints(["https://push.example/a", "https://push.example/b"]);
    // Simulate another tab adding C while A/B flush is in flight.
    rememberPushEndpoints([
      "https://push.example/a",
      "https://push.example/b",
      "https://push.example/c",
    ]);
    applyPendingCleanupFlushResult(
      ["https://push.example/a", "https://push.example/b"],
      ["https://push.example/b"],
    );
    expect(recalledPendingPushCleanup()).toEqual([
      "https://push.example/b",
      "https://push.example/c",
    ]);
  });
});

describe("unsubscribeLocalPushSubscription", () => {
  it("throws when subscription lookup fails instead of clearing orphan state", async () => {
    installPushEnv({
      permission: "granted",
      subscription: null,
      getSubscription: vi.fn().mockRejectedValue(new Error("lookup failed")),
    });
    rememberPushEndpoint("https://push.example/orphan");

    await expect(unsubscribeLocalPushSubscription("https://push.example/orphan")).rejects.toThrow(
      "push subscription lookup failed",
    );
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBe(
      "https://push.example/orphan",
    );
  });

  it("rejects a false unsubscribe result and retains the live subscription", async () => {
    const sub = makeFakePushSubscription();
    sub.unsubscribe.mockResolvedValue(false);
    const env = installPushEnv({ subscription: sub });
    await expect(unsubscribeLocalPushSubscription(sub.endpoint)).rejects.toThrow(
      "Push unsubscribe failed",
    );
    expect(env.subscription).toBe(sub);
  });

  it("reports mismatch without unsubscribing a different live endpoint", async () => {
    const live = makeFakePushSubscription({ endpoint: "https://push.example/b" });
    installPushEnv({ permission: "granted", subscription: live });

    await expect(unsubscribeLocalPushSubscription("https://push.example/a")).resolves.toEqual({
      status: "mismatch",
    });
    expect(live.unsubscribe).not.toHaveBeenCalled();
  });

  it("reports absent when there is no live subscription", async () => {
    installPushEnv({ permission: "granted", subscription: null });

    await expect(unsubscribeLocalPushSubscription("https://push.example/a")).resolves.toEqual({
      status: "absent",
    });
  });
});

describe("installPushEnv subscription persistence", () => {
  it("lets getSubscription observe subscribe and unsubscribe", async () => {
    installPushEnv({
      permission: "granted",
      subscription: null,
    });

    expect(await getCurrentPushSubscription()).toBeNull();
    await subscribeForPushNotifications(VAPID);
    const created = await getCurrentPushSubscription();
    expect(created?.endpoint).toBe("https://push.example/test-endpoint");
    if (!created) {
      throw new Error("expected push subscription after subscribe");
    }

    await created.unsubscribe();
    expect(await getCurrentPushSubscription()).toBeNull();
  });
});
