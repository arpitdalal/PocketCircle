import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canRegisterPushServiceWorker,
  disableCurrentPushSubscription,
  PUSH_SERVICE_WORKER_URL,
  readPushSubscriptionMaterial,
  registerPushServiceWorker,
  rememberPushEndpoint,
  resolvePushNotificationsCapability,
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

afterEach(() => {
  resetPushEnv();
  resetNavigatorInstallProps();
  rememberPushEndpoint(null);
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
    });
    expect(sub.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).not.toHaveBeenCalled();
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
});

describe("disableCurrentPushSubscription", () => {
  it("unbinds both live and remembered endpoints after a browser refresh", async () => {
    const sub = makeFakePushSubscription({ endpoint: "https://push.example/new" });
    installPushEnv({ permission: "granted", subscription: sub });
    rememberPushEndpoint("https://push.example/old");
    const disable = vi.fn().mockResolvedValue(undefined);

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
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("server down"));

    await expect(disableCurrentPushSubscription(disable)).rejects.toThrow("server down");
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBe(
      "https://push.example/old",
    );
  });
});
