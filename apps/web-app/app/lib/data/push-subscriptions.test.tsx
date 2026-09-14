import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEnableNotifications } from "~/lib/data/push-subscriptions.js";
import { deferredValue } from "~/lib/deferred.js";
import {
  clearLocalPushSubscriptionAndBinding,
  clearRememberedPushEndpoints,
  resetPushOperationState,
  vapidPublicKeyBytes,
  withPushSubscriptionLock,
} from "~/lib/push-subscriptions.js";
import { configureConvex } from "~/test/convex-react.js";
import { installPushEnv, makeFakePushSubscription, resetPushEnv } from "~/test/push-env.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

beforeEach(() => {
  clearRememberedPushEndpoints();
  resetPushOperationState();
});
afterEach(() => {
  resetPushEnv();
  resetPushOperationState();
  vi.useRealTimers();
});

const VAPID = { publicKey: "AQID", keyId: "primary" };

describe("enable operation ownership", () => {
  it("requests permission in the click stack and waits for the lock behind a peer enable", async () => {
    const env = installPushEnv();
    const bind = deferredValue<void>();
    const enable = vi.fn(() => bind.promise);
    const disable = vi.fn().mockResolvedValue({ removed: true });
    configureConvex({
      pushVapidPublicKey: VAPID,
      enablePushSubscription: enable,
      disablePushSubscription: disable,
    });
    const firstTab = renderHook(() => useEnableNotifications());
    const secondTab = renderHook(() => useEnableNotifications());
    const first = firstTab.result.current();
    expect(env.requestPermission).toHaveBeenCalledOnce();
    await waitFor(() => expect(enable).toHaveBeenCalledOnce());
    const second = secondTab.result.current();
    // Second waits on the lock (subscribe-before-lock must not use ifAvailable).
    expect(enable).toHaveBeenCalledOnce();
    bind.resolve();
    await first;
    await second;
    expect(env.subscription).not.toBeNull();
    expect(disable).not.toHaveBeenCalled();
    expect(enable.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("lets a waiting peer enable after the first enable succeeds", async () => {
    const env = installPushEnv();
    const bind = deferredValue<void>();
    const enable = vi.fn(() => bind.promise);
    const disable = vi.fn();
    configureConvex({
      pushVapidPublicKey: VAPID,
      enablePushSubscription: enable,
      disablePushSubscription: disable,
    });
    const firstTab = renderHook(() => useEnableNotifications());
    const secondTab = renderHook(() => useEnableNotifications());
    const first = firstTab.result.current();
    await waitFor(() => expect(enable).toHaveBeenCalledOnce());
    const second = secondTab.result.current();
    bind.resolve();
    await first;
    await second;
    expect(env.subscription).not.toBeNull();
    expect(disable).not.toHaveBeenCalled();
    expect(enable.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not unsubscribe a peer-bound endpoint when a later enable fails", async () => {
    const env = installPushEnv();
    const enable = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("transport lost"));
    const disable = vi.fn().mockResolvedValue({ removed: true });
    configureConvex({
      pushVapidPublicKey: VAPID,
      enablePushSubscription: enable,
      disablePushSubscription: disable,
      // After the first enable binds, ownership checks see the endpoint as ours.
      ownsPushEndpoint: () => enable.mock.calls.length >= 1,
    });
    const firstTab = renderHook(() => useEnableNotifications());
    const secondTab = renderHook(() => useEnableNotifications());
    await firstTab.result.current();
    await expect(secondTab.result.current()).rejects.toThrow("transport lost");
    expect(env.subscription).not.toBeNull();
    expect(disable).not.toHaveBeenCalled();
  });

  it("uses replacePushSubscription when Chromium forces a VAPID remigrate", async () => {
    const oldSub = makeFakePushSubscription({
      endpoint: "https://fcm.googleapis.com/fcm/send/old-key",
    });
    oldSub.options = { applicationServerKey: vapidPublicKeyBytes("BAQE") };
    installPushEnv({ permission: "granted", subscription: oldSub });
    const enable = vi.fn();
    const replace = vi.fn().mockResolvedValue({ bound: true });
    const disable = vi.fn();
    configureConvex({
      pushVapidPublicKey: VAPID,
      enablePushSubscription: enable,
      replacePushSubscription: replace,
      disablePushSubscription: disable,
    });
    const hook = renderHook(() => useEnableNotifications());
    await hook.result.current();
    expect(replace).toHaveBeenCalledWith(
      expect.objectContaining({
        previousEndpoint: "https://fcm.googleapis.com/fcm/send/old-key",
        endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint",
      }),
    );
    expect(enable).not.toHaveBeenCalled();
  });

  it("refuses enable when the display service worker cannot update", async () => {
    const env = installPushEnv();
    env.update.mockRejectedValue(new Error("offline"));
    const enable = vi.fn();
    configureConvex({
      pushVapidPublicKey: VAPID,
      enablePushSubscription: enable,
      disablePushSubscription: vi.fn(),
    });
    const hook = renderHook(() => useEnableNotifications());
    await expect(hook.result.current()).rejects.toThrow(/update failed/);
    expect(enable).not.toHaveBeenCalled();
  });

  it("disables previous endpoint when remigrate replace refuses then enable binds", async () => {
    const oldSub = makeFakePushSubscription({
      endpoint: "https://fcm.googleapis.com/fcm/send/old-key",
    });
    oldSub.options = { applicationServerKey: vapidPublicKeyBytes("BAQE") };
    installPushEnv({ permission: "granted", subscription: oldSub });
    const enable = vi.fn().mockResolvedValue(undefined);
    const replace = vi.fn().mockResolvedValue({ bound: false });
    const disable = vi.fn().mockResolvedValue({ removed: true });
    configureConvex({
      pushVapidPublicKey: VAPID,
      enablePushSubscription: enable,
      replacePushSubscription: replace,
      disablePushSubscription: disable,
    });
    const hook = renderHook(() => useEnableNotifications());
    await hook.result.current();
    expect(replace).toHaveBeenCalled();
    expect(enable).toHaveBeenCalled();
    expect(disable).toHaveBeenCalledWith({
      endpoint: "https://fcm.googleapis.com/fcm/send/old-key",
    });
  });

  it("subscribes before acquiring the Web Lock so remigrate keeps user activation", async () => {
    const env = installPushEnv({ permission: "granted" });
    const lockOrder: string[] = [];
    const realRequest = navigator.locks.request.bind(navigator.locks);
    vi.spyOn(navigator.locks, "request").mockImplementation((name, options, callback) => {
      lockOrder.push("lock");
      return realRequest(name, options, callback);
    });
    const originalSubscribe = env.subscribe.getMockImplementation();
    env.subscribe.mockImplementation(async (...args) => {
      lockOrder.push("subscribe");
      return originalSubscribe?.(...args);
    });
    configureConvex({
      pushVapidPublicKey: VAPID,
      enablePushSubscription: vi.fn().mockResolvedValue(undefined),
      disablePushSubscription: vi.fn(),
    });
    const hook = renderHook(() => useEnableNotifications());
    await hook.result.current();
    expect(lockOrder.indexOf("subscribe")).toBeLessThan(lockOrder.indexOf("lock"));
  });

  it("cancels a permission prompt that resolves after sign-out's deadline", async () => {
    vi.useFakeTimers();
    const permission = deferredValue<NotificationPermission>();
    const env = installPushEnv({ requestPermission: vi.fn(() => permission.promise) });
    const enable = vi.fn();
    const disable = vi.fn();
    configureConvex({
      pushVapidPublicKey: VAPID,
      enablePushSubscription: enable,
      disablePushSubscription: disable,
    });
    const hook = renderHook(() => useEnableNotifications());
    const enabling = hook.result.current();
    const cancelled = expect(enabling).rejects.toThrow("push enable cancelled");
    await vi.advanceTimersByTimeAsync(0);
    const signingOut = clearLocalPushSubscriptionAndBinding(disable);
    await vi.advanceTimersByTimeAsync(5_000);
    const release = await signingOut;
    release();
    permission.resolve("granted");
    await cancelled;
    expect(env.subscribe).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
    await withPushSubscriptionLock(async () => {});
  });
});
