/**
 * Browser-API boundary fakes for Push / Notifications / Permissions / SW
 * tests (issue #381). Stub only at the true boundary — never mock our hooks.
 */
import { type Mock, vi } from "vitest";

type PushSubFake = {
  endpoint: string;
  unsubscribe: Mock<() => Promise<boolean>>;
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
  options: { applicationServerKey?: ArrayBuffer | ArrayBufferView };
};

type InstallPushEnvOptions = {
  secureContext?: boolean;
  permission?: NotificationPermission;
  serviceWorker?: boolean;
  pushManager?: boolean;
  notification?: boolean;
  subscription?: PushSubFake | null;
  requestPermission?: Mock<() => Promise<NotificationPermission>>;
  subscribe?: Mock<() => Promise<PushSubFake>>;
  getSubscription?: Mock<() => Promise<PushSubFake | null>>;
  register?: Mock<() => Promise<{ pushManager: { subscribe: Mock; getSubscription: Mock } }>>;
};

const DEFAULT_ENDPOINT = "https://push.example/test-endpoint";

export function makeFakePushSubscription(
  over: Partial<{ endpoint: string; p256dh: string; auth: string }> = {},
) {
  const endpoint = over.endpoint ?? DEFAULT_ENDPOINT;
  const p256dh = over.p256dh ?? "p256dh-test";
  const auth = over.auth ?? "auth-test";
  return {
    endpoint,
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({ endpoint, keys: { p256dh, auth } }),
    options: {},
  };
}

/** Wire unsubscribe so getSubscription observes the removal (real PushManager). */
function trackSubscription(
  sub: PushSubFake,
  getCurrent: () => PushSubFake | null,
  setCurrent: (next: PushSubFake | null) => void,
) {
  const previous = sub.unsubscribe.getMockImplementation() ?? (async () => true);
  sub.unsubscribe = vi.fn(async () => {
    const result = await previous();
    if (getCurrent() === sub) {
      setCurrent(null);
    }
    return result;
  });
  return sub;
}

export function installPushEnv(options: InstallPushEnvOptions = {}) {
  const secureContext = options.secureContext ?? true;
  const permission = options.permission ?? "default";
  const withServiceWorker = options.serviceWorker ?? true;
  const withPushManager = options.pushManager ?? true;
  const withNotification = options.notification ?? true;

  let currentSubscription: PushSubFake | null =
    options.subscription === undefined ? null : options.subscription;
  if (currentSubscription) {
    trackSubscription(
      currentSubscription,
      () => currentSubscription,
      (next) => {
        currentSubscription = next;
      },
    );
  }

  const requestPermission =
    options.requestPermission ??
    vi.fn().mockResolvedValue(permission === "denied" ? "denied" : "granted");
  const subscribe =
    options.subscribe ??
    vi.fn().mockImplementation(async () => {
      if (!currentSubscription) {
        currentSubscription = trackSubscription(
          makeFakePushSubscription(),
          () => currentSubscription,
          (next) => {
            currentSubscription = next;
          },
        );
      }
      return currentSubscription;
    });
  const getSubscription =
    options.getSubscription ?? vi.fn().mockImplementation(async () => currentSubscription);
  const register =
    options.register ??
    vi.fn().mockResolvedValue({
      pushManager: { subscribe, getSubscription },
    });

  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    get: () => secureContext,
  });

  if (withNotification) {
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: {
        permission,
        requestPermission,
      },
    });
  } else {
    Reflect.deleteProperty(window, "Notification");
  }

  if (withPushManager) {
    Object.defineProperty(window, "PushManager", {
      configurable: true,
      value: function PushManager() {},
    });
  } else {
    Reflect.deleteProperty(window, "PushManager");
  }

  if (withServiceWorker) {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register,
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: { subscribe, getSubscription },
        }),
        ready: Promise.resolve({
          pushManager: { subscribe, getSubscription },
        }),
      },
    });
  } else {
    Reflect.deleteProperty(navigator, "serviceWorker");
  }

  return {
    requestPermission,
    subscribe,
    getSubscription,
    register,
    get subscription() {
      return currentSubscription;
    },
  };
}

export function resetPushEnv() {
  Reflect.deleteProperty(window, "Notification");
  Reflect.deleteProperty(window, "PushManager");
  Reflect.deleteProperty(navigator, "serviceWorker");
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    get: () => true,
  });
}
