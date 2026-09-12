import { afterEach, describe, expect, it, vi } from "vitest";
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
  isPushEnableInFlight,
  PUSH_SERVICE_WORKER_URL,
  readPushSubscriptionMaterial,
  recalledPendingPushCleanup,
  recalledPushEndpoints,
  recordOrphanLocalDrop,
  registerPushServiceWorker,
  rememberPushEndpoint,
  rememberPushEndpoints,
  resetPushEnableLeases,
  resolvePushNotificationsCapability,
  subscribeForPushNotifications,
  unsubscribeLocalPushSubscription,
  vapidPublicKeyBytes,
} from "~/lib/push-subscriptions.js";
import { installPushEnv, makeFakePushSubscription, resetPushEnv } from "~/test/push-env.js";
import {
  installMatchMediaFake,
  resetNavigatorInstallProps,
  setNavigatorInstallProps,
} from "~/test/pwa-install-env.js";

const VAPID_PUBLIC_KEY = "AQID";
const VAPID = { publicKey: VAPID_PUBLIC_KEY, keyId: "primary" };
const PENDING_PUSH_CLEANUP_KEY = "pocketcircle.pendingPushCleanup";

afterEach(() => {
  resetPushEnv();
  resetNavigatorInstallProps();
  clearRememberedPushEndpoints();
  resetPushEnableLeases();
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

describe("push enable in-flight coordination", () => {
  it("keeps cross-tab enables visible until every tab ends", () => {
    vi.useFakeTimers();
    // Simulate another tab's lease without touching this tab's counter.
    window.localStorage.setItem("pocketcircle.pushEnableLease.other-tab", String(Date.now()));
    expect(isPushEnableInFlight()).toBe(true);

    beginPushEnable();
    endPushEnable();
    // Other tab still in flight.
    expect(isPushEnableInFlight()).toBe(true);

    window.localStorage.removeItem("pocketcircle.pushEnableLease.other-tab");
    // Local grace still holds briefly after endPushEnable.
    expect(isPushEnableInFlight()).toBe(true);
    vi.advanceTimersByTime(12_000);
    expect(isPushEnableInFlight()).toBe(false);
    vi.useRealTimers();
  });

  it("keeps concurrent tab leases independent", () => {
    vi.useFakeTimers();
    beginPushEnable();
    beginPushEnable();
    endPushEnable();
    // One local lease remains.
    expect(isPushEnableInFlight()).toBe(true);
    endPushEnable();
    expect(isPushEnableInFlight()).toBe(true);
    vi.advanceTimersByTime(12_000);
    expect(isPushEnableInFlight()).toBe(false);
    vi.useRealTimers();
  });

  it("heartbeats so a long enable does not expire for other tabs", () => {
    vi.useFakeTimers();
    beginPushEnable();

    vi.advanceTimersByTime(90_000);
    const leaseKeys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key?.startsWith("pocketcircle.pushEnableLease.")) {
        leaseKeys.push(key);
      }
    }
    expect(leaseKeys).toHaveLength(1);
    const [leaseKey] = leaseKeys;
    const raw = window.localStorage.getItem(leaseKey ?? "") ?? "";
    const startedAt = Number(raw.split("|")[0]);
    expect(Number.isFinite(startedAt)).toBe(true);
    expect(raw.endsWith("|active")).toBe(true);
    // Lease stayed within TTL of "now" thanks to heartbeats.
    expect(Date.now() - startedAt).toBeLessThan(60_000);

    endPushEnable();
    vi.advanceTimersByTime(12_000);
    expect(isPushEnableInFlight()).toBe(false);
    vi.useRealTimers();
  });

  it("holds a post-commit grace so orphan drop cannot race enable", () => {
    vi.useFakeTimers();
    beginPushEnable();
    endPushEnable();
    expect(isPushEnableInFlight()).toBe(true);
    vi.advanceTimersByTime(11_999);
    expect(isPushEnableInFlight()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isPushEnableInFlight()).toBe(false);
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

  it("cancels and waits for in-flight enable before sign-out cleanup", async () => {
    installPushEnv({
      permission: "granted",
      subscription: makeFakePushSubscription(),
    });
    beginPushEnable();
    const disable = vi.fn().mockResolvedValue({ removed: true });

    const done = clearLocalPushSubscriptionAndBinding(disable);
    await Promise.resolve();
    expect(isPushEnableCancelRequested()).toBe(true);
    expect(window.localStorage.getItem("pocketcircle.pushEnableCancel")).not.toBeNull();
    expect(disable).not.toHaveBeenCalled();

    // A concurrent enable must not clear sign-out's cancel flag.
    beginPushEnable();
    expect(isPushEnableCancelRequested()).toBe(true);
    endPushEnable();

    endPushEnable();
    const release = await done;

    expect(disable).toHaveBeenCalled();
    // Cancel stays until caller releases after signOut settles.
    expect(isPushEnableCancelRequested()).toBe(true);
    release();
    expect(isPushEnableCancelRequested()).toBe(false);
  });

  it("waits for a cross-tab active enable lease before cleanup", async () => {
    installPushEnv({
      permission: "granted",
      subscription: makeFakePushSubscription(),
    });
    window.localStorage.setItem("pocketcircle.pushEnableLease.other-tab", `${Date.now()}|active`);
    const disable = vi.fn().mockResolvedValue({ removed: true });

    const done = clearLocalPushSubscriptionAndBinding(disable);
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 40);
    });
    expect(isPushEnableCancelRequested()).toBe(true);
    expect(disable).not.toHaveBeenCalled();

    window.localStorage.removeItem("pocketcircle.pushEnableLease.other-tab");
    const release = await done;
    release();

    expect(disable).toHaveBeenCalled();
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

  it("uses one shared deadline across enable-wait and disable", async () => {
    vi.useFakeTimers();
    installPushEnv({
      permission: "granted",
      subscription: makeFakePushSubscription(),
    });
    beginPushEnable();
    const disable = vi.fn().mockImplementation(() => new Promise(() => {}));

    const done = clearLocalPushSubscriptionAndBinding(disable);
    // Wait is capped so ~1s remains for disable inside the 5s deadline.
    await vi.advanceTimersByTimeAsync(3_500);
    endPushEnable();
    await vi.advanceTimersByTimeAsync(100);
    expect(disable).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    const release = await done;
    release();
    vi.useRealTimers();
  });

  it("still attempts disable when enable-wait consumes its budget", async () => {
    vi.useFakeTimers();
    installPushEnv({
      permission: "granted",
      subscription: makeFakePushSubscription(),
    });
    window.localStorage.setItem("pocketcircle.pushEnableLease.stuck", `${Date.now()}|active`);
    const disable = vi.fn().mockResolvedValue({ removed: true });

    const done = clearLocalPushSubscriptionAndBinding(disable);
    // Wait budget is 4s (5s - 1s reserved); advance past it while lease stays active.
    await vi.advanceTimersByTimeAsync(4_100);
    const release = await done;
    release();
    expect(disable).toHaveBeenCalled();
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
    expect(window.localStorage.getItem(PENDING_PUSH_CLEANUP_KEY)).toBe("https://push.example/old");
  });

  it("keeps pending cleanup when disable does not remove a foreign binding", async () => {
    installPushEnv({ permission: "granted", subscription: null });
    rememberPushEndpoints(["https://push.example/alice-stale"]);
    const disable = vi.fn().mockResolvedValue({ removed: false });

    await expect(disableCurrentPushSubscription(disable)).rejects.toThrow(
      "push binding not removed",
    );
    expect(window.localStorage.getItem(PENDING_PUSH_CLEANUP_KEY)).toBe(
      "https://push.example/alice-stale",
    );
  });

  it("retains every endpoint whose disable failed", async () => {
    const sub = makeFakePushSubscription({ endpoint: "https://push.example/new" });
    installPushEnv({ permission: "granted", subscription: sub });
    rememberPushEndpoint("https://push.example/old");
    const disable = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(disableCurrentPushSubscription(disable)).rejects.toThrow("offline");
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(PENDING_PUSH_CLEANUP_KEY) ?? "null")).toEqual([
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
      "https://push.example/c",
      "https://push.example/b",
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

  it("aborts before unsubscribe when enable is in flight", async () => {
    const sub = makeFakePushSubscription({ endpoint: "https://push.example/race" });
    installPushEnv({ permission: "granted", subscription: sub });
    beginPushEnable();

    await expect(
      unsubscribeLocalPushSubscription(sub.endpoint, { abortIfEnableInFlight: true }),
    ).rejects.toThrow("push enable in flight");
    expect(sub.unsubscribe).not.toHaveBeenCalled();
    endPushEnable();
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
