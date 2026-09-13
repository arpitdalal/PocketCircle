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
import { TEST_PUSH_AUTH, TEST_PUSH_P256DH } from "~/test/push-fixtures.js";
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
  it("resubscribes on VAPID mismatch for ownership-safe migrate", async () => {
    const old = makeFakePushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/old" });
    old.options = { applicationServerKey: vapidPublicKeyBytes("BAQE") };
    const next = makeFakePushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/new" });
    next.options = { applicationServerKey: vapidPublicKeyBytes(VAPID_PUBLIC_KEY) };
    const { subscribe } = installPushEnv({
      permission: "granted",
      subscription: old,
      subscribe: vi.fn().mockResolvedValue(next),
    });

    await expect(readPushSubscriptionMaterial(VAPID)).resolves.toEqual({
      subscription: {
        endpoint: "https://fcm.googleapis.com/fcm/send/new",
        p256dh: TEST_PUSH_P256DH,
        auth: TEST_PUSH_AUTH,
        vapidKeyId: "primary",
      },
      previousEndpoint: "https://fcm.googleapis.com/fcm/send/old",
    });
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("falls back to unbound cleanup when VAPID remigrate subscribe fails", async () => {
    const old = makeFakePushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/old" });
    old.options = { applicationServerKey: vapidPublicKeyBytes("BAQE") };
    const { subscribe } = installPushEnv({
      permission: "granted",
      subscription: old,
      subscribe: vi.fn().mockRejectedValue(new Error("subscribe failed")),
    });

    await expect(readPushSubscriptionMaterial(VAPID)).resolves.toEqual({
      subscription: null,
      unboundEndpoint: "https://fcm.googleapis.com/fcm/send/old",
      unboundEndpoints: ["https://fcm.googleapis.com/fcm/send/old"],
    });
    expect(old.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("unsubscribes the remigrated subscription when reconcile cancels mid-flight", async () => {
    const old = makeFakePushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/old" });
    old.options = { applicationServerKey: vapidPublicKeyBytes("BAQE") };
    const next = makeFakePushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/new" });
    next.options = { applicationServerKey: vapidPublicKeyBytes(VAPID_PUBLIC_KEY) };
    let cancelled = false;
    installPushEnv({
      permission: "granted",
      subscription: old,
      subscribe: vi.fn().mockImplementation(async () => {
        cancelled = true;
        return next;
      }),
    });
    await expect(readPushSubscriptionMaterial(VAPID, () => cancelled)).resolves.toEqual({
      subscription: null,
    });
    expect(next.unsubscribe).toHaveBeenCalledOnce();
  });

  it("remembers the remigrated endpoint when cancel cleanup unsubscribe fails", async () => {
    const old = makeFakePushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/old" });
    old.options = { applicationServerKey: vapidPublicKeyBytes("BAQE") };
    const next = makeFakePushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/new" });
    next.options = { applicationServerKey: vapidPublicKeyBytes(VAPID_PUBLIC_KEY) };
    next.unsubscribe = vi.fn().mockRejectedValue(new Error("unsubscribe failed"));
    let cancelled = false;
    installPushEnv({
      permission: "granted",
      subscription: old,
      subscribe: vi.fn().mockImplementation(async () => {
        cancelled = true;
        return next;
      }),
    });
    await expect(readPushSubscriptionMaterial(VAPID, () => cancelled)).resolves.toEqual({
      subscription: null,
      unboundEndpoint: "https://fcm.googleapis.com/fcm/send/new",
      unboundEndpoints: [
        "https://fcm.googleapis.com/fcm/send/new",
        "https://fcm.googleapis.com/fcm/send/old",
      ],
    });
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBe(
      "https://fcm.googleapis.com/fcm/send/new",
    );
  });

  it("does not unbind the server when VAPID unsubscribe fails", async () => {
    const sub = makeFakePushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/old" });
    sub.options = { applicationServerKey: vapidPublicKeyBytes("BAQE") };
    sub.unsubscribe = vi.fn().mockRejectedValue(new Error("unsubscribe failed"));
    installPushEnv({ permission: "granted", subscription: sub });

    await expect(readPushSubscriptionMaterial(VAPID)).resolves.toEqual({
      subscription: null,
    });
  });

  it("reports previousEndpoint when the browser refreshes the endpoint", async () => {
    const sub = makeFakePushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/new" });
    sub.options = { applicationServerKey: vapidPublicKeyBytes(VAPID_PUBLIC_KEY) };
    installPushEnv({ permission: "granted", subscription: sub });
    rememberPushEndpoint("https://fcm.googleapis.com/fcm/send/old");

    await expect(readPushSubscriptionMaterial(VAPID)).resolves.toEqual({
      subscription: {
        endpoint: "https://fcm.googleapis.com/fcm/send/new",
        p256dh: TEST_PUSH_P256DH,
        auth: TEST_PUSH_AUTH,
        vapidKeyId: "primary",
      },
      previousEndpoint: "https://fcm.googleapis.com/fcm/send/old",
    });
    // Keep old endpoint remembered until replace succeeds.
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBe(
      "https://fcm.googleapis.com/fcm/send/old",
    );
  });

  it("returns matching material without previousEndpoint when unchanged", async () => {
    const sub = makeFakePushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/same" });
    sub.options = { applicationServerKey: vapidPublicKeyBytes(VAPID_PUBLIC_KEY) };
    installPushEnv({ permission: "granted", subscription: sub });
    rememberPushEndpoint("https://fcm.googleapis.com/fcm/send/same");

    await expect(readPushSubscriptionMaterial(VAPID)).resolves.toEqual({
      subscription: {
        endpoint: "https://fcm.googleapis.com/fcm/send/same",
        p256dh: TEST_PUSH_P256DH,
        auth: TEST_PUSH_AUTH,
        vapidKeyId: "primary",
      },
    });
  });

  it("unbinds a remembered endpoint when the browser has no subscription", async () => {
    installPushEnv({ permission: "granted", subscription: null });
    rememberPushEndpoint("https://fcm.googleapis.com/fcm/send/stale");

    await expect(readPushSubscriptionMaterial(VAPID)).resolves.toEqual({
      subscription: null,
      unboundEndpoint: "https://fcm.googleapis.com/fcm/send/stale",
      unboundEndpoints: ["https://fcm.googleapis.com/fcm/send/stale"],
    });
  });

  it("does not unbind remembered endpoints when subscription lookup fails", async () => {
    installPushEnv({
      permission: "granted",
      subscription: null,
      getSubscription: vi.fn().mockRejectedValue(new Error("lookup failed")),
    });
    rememberPushEndpoint("https://fcm.googleapis.com/fcm/send/stale");

    await expect(readPushSubscriptionMaterial(VAPID)).resolves.toEqual({
      subscription: null,
    });
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBe(
      "https://fcm.googleapis.com/fcm/send/stale",
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
    const oldSub = makeFakePushSubscription({
      endpoint: "https://fcm.googleapis.com/fcm/send/old",
    });
    installPushEnv({ permission: "granted", subscription: oldSub });
    rememberPushEndpoint("https://fcm.googleapis.com/fcm/send/old");

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
    const nextSub = makeFakePushSubscription({
      endpoint: "https://fcm.googleapis.com/fcm/send/next",
    });
    installPushEnv({ permission: "granted", subscription: nextSub });
    rememberPushEndpoint("https://fcm.googleapis.com/fcm/send/next");

    releaseDisable();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    release();

    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBe(
      "https://fcm.googleapis.com/fcm/send/next",
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
    rememberPushEndpoint("https://fcm.googleapis.com/fcm/send/remembered");
    const disable = vi.fn().mockResolvedValue({ removed: true });

    const release = await clearLocalPushSubscriptionAndBinding(disable);
    release();

    expect(disable).toHaveBeenCalledWith({
      endpoint: "https://fcm.googleapis.com/fcm/send/remembered",
    });
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBeNull();
  });

  it("keeps a timed-out unsubscribe locked and preserves its retry handle", async () => {
    vi.useFakeTimers();
    const pending = deferredValue<boolean>();
    const sub = makeFakePushSubscription();
    sub.unsubscribe.mockImplementation(() => pending.promise);
    const env = installPushEnv({ subscription: sub });
    rememberPushEndpoint(sub.endpoint);
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
    // Snapshot unbind still attempts server disable after the wait; without
    // `{ removed: true }` the endpoint stays pending for retry.
    expect(disable).toHaveBeenCalledWith({ endpoint: sub.endpoint });
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

  it("still unbinds the sign-out snapshot after a busy lock exceeds the wait", async () => {
    vi.useFakeTimers();
    const sub = makeFakePushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/old" });
    installPushEnv({ permission: "granted", subscription: sub });
    rememberPushEndpoint("https://fcm.googleapis.com/fcm/send/old");
    const pending = deferredValue<void>();
    const started = deferredValue<void>();
    const active = withPushSubscriptionLock(async () => {
      started.resolve();
      await pending.promise;
    });
    await started.promise;
    const disable = vi.fn().mockResolvedValue({ removed: true });
    const done = clearLocalPushSubscriptionAndBinding(disable);
    await vi.advanceTimersByTimeAsync(5_000);
    const release = await done;
    release();
    expect(disable).not.toHaveBeenCalled();
    pending.resolve();
    await active;
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(disable).toHaveBeenCalledWith({ endpoint: "https://fcm.googleapis.com/fcm/send/old" });
    expect(sub.unsubscribe).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("freezes a live-only endpoint before lock work (no remembered binding)", async () => {
    // Regression: racing live capture against lock acquisition left onlyEndpoints
    // empty, so account-menu sign-out skipped unsubscribe and called signOut early.
    const sub = makeFakePushSubscription({
      endpoint: "https://fcm.googleapis.com/fcm/send/live-only",
    });
    let releaseUnsubscribe = () => {};
    sub.unsubscribe.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseUnsubscribe = () => resolve(true);
        }),
    );
    installPushEnv({ permission: "granted", subscription: sub });
    const disable = vi.fn().mockResolvedValue({ removed: true });

    const done = clearLocalPushSubscriptionAndBinding(disable);
    let settled = false;
    void done.then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    });
    expect(settled).toBe(false);
    expect(disable).not.toHaveBeenCalled();

    releaseUnsubscribe();
    const release = await done;
    release();
    expect(disable).toHaveBeenCalledWith({
      endpoint: "https://fcm.googleapis.com/fcm/send/live-only",
    });
  });

  it("does not unsubscribe a later session endpoint after a deferred sign-out cleanup", async () => {
    vi.useFakeTimers();
    installPushEnv({
      subscription: makeFakePushSubscription({
        endpoint: "https://fcm.googleapis.com/fcm/send/old",
      }),
    });
    rememberPushEndpoint("https://fcm.googleapis.com/fcm/send/old");
    const pending = deferredValue<void>();
    const started = deferredValue<void>();
    const active = withPushSubscriptionLock(async () => {
      started.resolve();
      await pending.promise;
    });
    await started.promise;
    const disable = vi.fn().mockResolvedValue({ removed: true });
    const done = clearLocalPushSubscriptionAndBinding(disable);
    await vi.advanceTimersByTimeAsync(5_000);
    const release = await done;
    release();

    const nextSub = makeFakePushSubscription({
      endpoint: "https://fcm.googleapis.com/fcm/send/next",
    });
    // Reinstalling Push env must preserve the held lock (real LockManager is a singleton).
    installPushEnv({ permission: "granted", subscription: nextSub });
    rememberPushEndpoint("https://fcm.googleapis.com/fcm/send/next");
    expect(disable).not.toHaveBeenCalled();

    pending.resolve();
    await active;
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(disable).toHaveBeenCalledWith({ endpoint: "https://fcm.googleapis.com/fcm/send/old" });
    expect(disable).not.toHaveBeenCalledWith({
      endpoint: "https://fcm.googleapis.com/fcm/send/next",
    });
    expect(nextSub.unsubscribe).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBe(
      "https://fcm.googleapis.com/fcm/send/next",
    );
    vi.useRealTimers();
  });

  it("still returns a release when crypto.randomUUID is unavailable", async () => {
    installPushEnv({
      permission: "granted",
      subscription: makeFakePushSubscription(),
    });
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      throw new Error("randomUUID unavailable");
    });
    try {
      const disable = vi.fn().mockResolvedValue({ removed: true });
      const release = await clearLocalPushSubscriptionAndBinding(disable);
      release();
      expect(disable).toHaveBeenCalled();
    } finally {
      randomUUID.mockRestore();
    }
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
    const sub = makeFakePushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/new" });
    installPushEnv({ permission: "granted", subscription: sub });
    rememberPushEndpoint("https://fcm.googleapis.com/fcm/send/old");
    const disable = vi.fn().mockResolvedValue({ removed: true });

    await disableCurrentPushSubscription(disable);

    expect(sub.unsubscribe).toHaveBeenCalledOnce();
    expect(disable).toHaveBeenCalledWith({ endpoint: "https://fcm.googleapis.com/fcm/send/new" });
    expect(disable).toHaveBeenCalledWith({ endpoint: "https://fcm.googleapis.com/fcm/send/old" });
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBeNull();
  });

  it("retains a remembered endpoint when disable fails", async () => {
    const sub = makeFakePushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/new" });
    installPushEnv({ permission: "granted", subscription: sub });
    rememberPushEndpoint("https://fcm.googleapis.com/fcm/send/old");
    const disable = vi
      .fn()
      .mockResolvedValueOnce({ removed: true })
      .mockRejectedValueOnce(new Error("server down"));

    await expect(disableCurrentPushSubscription(disable)).rejects.toThrow("server down");
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBeNull();
    expect(recalledPendingPushCleanup()).toEqual(["https://fcm.googleapis.com/fcm/send/old"]);
  });

  it("keeps pending cleanup when disable does not remove a foreign binding", async () => {
    installPushEnv({ permission: "granted", subscription: null });
    rememberPushEndpoints(["https://fcm.googleapis.com/fcm/send/alice-stale"]);
    const disable = vi.fn().mockResolvedValue({ removed: false });

    await expect(disableCurrentPushSubscription(disable)).resolves.toBeUndefined();
    expect(recalledPendingPushCleanup()).toEqual([
      "https://fcm.googleapis.com/fcm/send/alice-stale",
    ]);
  });

  it("does not fail a successful current-device disable for an unrelated retry", async () => {
    const sub = makeFakePushSubscription();
    installPushEnv({ subscription: sub });
    rememberPushEndpoint(sub.endpoint);
    rememberPushEndpoints(["https://fcm.googleapis.com/fcm/send/foreign"]);
    const disable = vi.fn(async ({ endpoint }: { endpoint: string }) => ({
      removed: endpoint === sub.endpoint,
    }));
    await expect(disableCurrentPushSubscription(disable)).resolves.toBeUndefined();
    expect(recalledPendingPushCleanup()).toEqual(["https://fcm.googleapis.com/fcm/send/foreign"]);
  });

  it("cannot overwrite another endpoint inserted during cleanup storage writes", () => {
    rememberPushEndpoints([
      "https://fcm.googleapis.com/fcm/send/a",
      "https://fcm.googleapis.com/fcm/send/b",
    ]);
    const remove = window.localStorage.removeItem.bind(window.localStorage);
    const spy = vi.spyOn(window.localStorage, "removeItem").mockImplementation((key) => {
      remove(key);
      if (key.endsWith("https://fcm.googleapis.com/fcm/send/a"))
        rememberPushEndpoints(["https://fcm.googleapis.com/fcm/send/c"]);
    });
    try {
      applyPendingCleanupFlushResult(
        ["https://fcm.googleapis.com/fcm/send/a", "https://fcm.googleapis.com/fcm/send/b"],
        ["https://fcm.googleapis.com/fcm/send/b"],
      );
      expect(recalledPendingPushCleanup()).toEqual([
        "https://fcm.googleapis.com/fcm/send/b",
        "https://fcm.googleapis.com/fcm/send/c",
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("retains every endpoint whose disable failed", async () => {
    const sub = makeFakePushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/new" });
    installPushEnv({ permission: "granted", subscription: sub });
    rememberPushEndpoint("https://fcm.googleapis.com/fcm/send/old");
    const disable = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(disableCurrentPushSubscription(disable)).rejects.toThrow("offline");
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBeNull();
    expect(recalledPendingPushCleanup()).toEqual([
      "https://fcm.googleapis.com/fcm/send/new",
      "https://fcm.googleapis.com/fcm/send/old",
    ]);
  });

  it("keeps pending cleanup endpoints across re-enable", async () => {
    rememberPushEndpoints([
      "https://fcm.googleapis.com/fcm/send/stale-a",
      "https://fcm.googleapis.com/fcm/send/stale-b",
    ]);
    installPushEnv({ permission: "granted", subscription: null });

    await subscribeForPushNotifications(VAPID);

    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBe(
      "https://fcm.googleapis.com/fcm/send/test-endpoint",
    );
    expect(recalledPushEndpoints()).toEqual([
      "https://fcm.googleapis.com/fcm/send/test-endpoint",
      "https://fcm.googleapis.com/fcm/send/stale-a",
      "https://fcm.googleapis.com/fcm/send/stale-b",
    ]);
    expect(recalledPendingPushCleanup()).toEqual([
      "https://fcm.googleapis.com/fcm/send/stale-a",
      "https://fcm.googleapis.com/fcm/send/stale-b",
    ]);
  });

  it("throws on lookup failure without sign-out fallback (Settings)", async () => {
    installPushEnv({
      permission: "granted",
      subscription: null,
      getSubscription: vi.fn().mockRejectedValue(new Error("lookup failed")),
    });
    rememberPushEndpoint("https://fcm.googleapis.com/fcm/send/remembered");
    const disable = vi.fn().mockResolvedValue({ removed: true });

    await expect(disableCurrentPushSubscription(disable)).rejects.toThrow(
      "push subscription lookup failed",
    );
    expect(disable).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBe(
      "https://fcm.googleapis.com/fcm/send/remembered",
    );
  });

  it("preserves the previous active endpoint when explicit enable replaces it", async () => {
    const sub = makeFakePushSubscription({
      endpoint: "https://fcm.googleapis.com/fcm/send/old-key",
    });
    sub.options = { applicationServerKey: vapidPublicKeyBytes("BAQE") };
    installPushEnv({ subscription: sub });
    rememberPushEndpoint(sub.endpoint);
    await subscribeForPushNotifications(VAPID);
    expect(recalledPendingPushCleanup()).toEqual([sub.endpoint]);
  });

  it("removes an endpoint from pending when it becomes active again", () => {
    rememberPushEndpoints([
      "https://fcm.googleapis.com/fcm/send/a",
      "https://fcm.googleapis.com/fcm/send/b",
    ]);
    rememberPushEndpoint("https://fcm.googleapis.com/fcm/send/a");
    expect(recalledPendingPushCleanup()).toEqual(["https://fcm.googleapis.com/fcm/send/b"]);
  });

  it("preserves foreign orphan endpoints as pending cleanup", () => {
    rememberPushEndpoint("https://fcm.googleapis.com/fcm/send/alice");
    recordOrphanLocalDrop("https://fcm.googleapis.com/fcm/send/alice");
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBeNull();
    expect(recalledPendingPushCleanup()).toEqual(["https://fcm.googleapis.com/fcm/send/alice"]);
  });

  it("merges pending cleanup flush results without wiping newer endpoints", () => {
    rememberPushEndpoints([
      "https://fcm.googleapis.com/fcm/send/a",
      "https://fcm.googleapis.com/fcm/send/b",
    ]);
    // Simulate another tab adding C while A/B flush is in flight.
    rememberPushEndpoints([
      "https://fcm.googleapis.com/fcm/send/a",
      "https://fcm.googleapis.com/fcm/send/b",
      "https://fcm.googleapis.com/fcm/send/c",
    ]);
    applyPendingCleanupFlushResult(
      ["https://fcm.googleapis.com/fcm/send/a", "https://fcm.googleapis.com/fcm/send/b"],
      ["https://fcm.googleapis.com/fcm/send/b"],
    );
    expect(recalledPendingPushCleanup()).toEqual([
      "https://fcm.googleapis.com/fcm/send/b",
      "https://fcm.googleapis.com/fcm/send/c",
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
    rememberPushEndpoint("https://fcm.googleapis.com/fcm/send/orphan");

    await expect(
      unsubscribeLocalPushSubscription("https://fcm.googleapis.com/fcm/send/orphan"),
    ).rejects.toThrow("push subscription lookup failed");
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBe(
      "https://fcm.googleapis.com/fcm/send/orphan",
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
    const live = makeFakePushSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/b" });
    installPushEnv({ permission: "granted", subscription: live });

    await expect(
      unsubscribeLocalPushSubscription("https://fcm.googleapis.com/fcm/send/a"),
    ).resolves.toEqual({
      status: "mismatch",
    });
    expect(live.unsubscribe).not.toHaveBeenCalled();
  });

  it("reports absent when there is no live subscription", async () => {
    installPushEnv({ permission: "granted", subscription: null });

    await expect(
      unsubscribeLocalPushSubscription("https://fcm.googleapis.com/fcm/send/a"),
    ).resolves.toEqual({
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
    expect(created?.endpoint).toBe("https://fcm.googleapis.com/fcm/send/test-endpoint");
    if (!created) {
      throw new Error("expected push subscription after subscribe");
    }

    await created.unsubscribe();
    expect(await getCurrentPushSubscription()).toBeNull();
  });
});
