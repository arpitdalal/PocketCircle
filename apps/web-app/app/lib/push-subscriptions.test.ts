import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canRegisterPushServiceWorker,
  PUSH_SERVICE_WORKER_URL,
  readPushSubscriptionMaterial,
  registerPushServiceWorker,
  rememberPushEndpoint,
  resolvePushNotificationsCapability,
} from "~/lib/push-subscriptions.js";
import { installPushEnv, makeFakePushSubscription, resetPushEnv } from "~/test/push-env.js";
import {
  installMatchMediaFake,
  resetNavigatorInstallProps,
  setNavigatorInstallProps,
} from "~/test/pwa-install-env.js";

const VAPID_PUBLIC_KEY = "AQID";
const VAPID = { publicKey: VAPID_PUBLIC_KEY, keyId: "primary" };

function applicationServerKeyFor(publicKey: string) {
  const padding = "=".repeat((4 - (publicKey.length % 4)) % 4);
  const base64 = (publicKey + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes.buffer;
}

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
    sub.options = { applicationServerKey: applicationServerKeyFor("BAQE") };
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
    sub.options = { applicationServerKey: applicationServerKeyFor(VAPID_PUBLIC_KEY) };
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
    sub.options = { applicationServerKey: applicationServerKeyFor(VAPID_PUBLIC_KEY) };
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
