import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginPushEnable,
  canRegisterPushServiceWorker,
  clearLocalPushSubscriptionAndBinding,
  clearRememberedPushEndpoints,
  disableCurrentPushSubscription,
  endPushEnable,
  getCurrentPushSubscription,
  isPushEnableInFlight,
  PUSH_SERVICE_WORKER_URL,
  readPushSubscriptionMaterial,
  recalledPushEndpoints,
  registerPushServiceWorker,
  rememberPushEndpoint,
  rememberPushEndpoints,
  resolvePushNotificationsCapability,
  subscribeForPushNotifications,
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
  window.localStorage.removeItem("pocketcircle.pushEnableInFlight");
  while (isPushEnableInFlight()) {
    endPushEnable();
  }
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
    // Simulate another tab's begin without touching this tab's counter.
    window.localStorage.setItem(
      "pocketcircle.pushEnableInFlight",
      JSON.stringify({ count: 1, updatedAt: Date.now() }),
    );
    expect(isPushEnableInFlight()).toBe(true);

    beginPushEnable();
    endPushEnable();
    // Other tab still in flight.
    expect(isPushEnableInFlight()).toBe(true);

    window.localStorage.removeItem("pocketcircle.pushEnableInFlight");
    expect(isPushEnableInFlight()).toBe(false);
  });

  it("heartbeats so a long enable does not expire for other tabs", () => {
    vi.useFakeTimers();
    beginPushEnable();

    vi.advanceTimersByTime(90_000);
    const raw = window.localStorage.getItem("pocketcircle.pushEnableInFlight");
    expect(raw).not.toBeNull();
    const marker: unknown = JSON.parse(raw ?? "null");
    expect(marker).toEqual(expect.objectContaining({ count: 1 }));
    if (
      typeof marker === "object" &&
      marker !== null &&
      "updatedAt" in marker &&
      typeof marker.updatedAt === "number"
    ) {
      // Marker stayed within TTL of "now" thanks to heartbeats.
      expect(Date.now() - marker.updatedAt).toBeLessThan(60_000);
    } else {
      expect.unreachable("expected in-flight marker");
    }

    endPushEnable();
    expect(window.localStorage.getItem("pocketcircle.pushEnableInFlight")).toBeNull();
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
    await expect(done).resolves.toBeUndefined();
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
    await expect(done).resolves.toBeUndefined();

    // Later session enables Push before the stalled disable settles.
    const nextSub = makeFakePushSubscription({ endpoint: "https://push.example/next" });
    installPushEnv({ permission: "granted", subscription: nextSub });
    rememberPushEndpoint("https://push.example/next");

    releaseDisable();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBe(
      "https://push.example/next",
    );
    expect(nextSub.unsubscribe).not.toHaveBeenCalled();
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
