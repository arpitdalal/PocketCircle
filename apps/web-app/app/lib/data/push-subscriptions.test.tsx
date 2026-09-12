import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEnableNotifications } from "~/lib/data/push-subscriptions.js";
import { deferredValue } from "~/lib/deferred.js";
import {
  clearLocalPushSubscriptionAndBinding,
  clearRememberedPushEndpoints,
  resetPushOperationState,
  withPushSubscriptionLock,
} from "~/lib/push-subscriptions.js";
import { configureConvex } from "~/test/convex-react.js";
import { installPushEnv, resetPushEnv } from "~/test/push-env.js";

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
  it("requests permission in the click stack and excludes competing enable through compensation", async () => {
    const env = installPushEnv();
    const bind = deferredValue<void>();
    const cleanup = deferredValue<{ removed: boolean }>();
    const enable = vi.fn(() => bind.promise);
    const disable = vi.fn(() => cleanup.promise);
    configureConvex({
      pushVapidPublicKey: VAPID,
      enablePushSubscription: enable,
      disablePushSubscription: disable,
    });
    const firstTab = renderHook(() => useEnableNotifications());
    const secondTab = renderHook(() => useEnableNotifications());
    const first = firstTab.result.current();
    expect(env.requestPermission).toHaveBeenCalledOnce();
    const failed = expect(first).rejects.toThrow("response lost");
    await waitFor(() => expect(enable).toHaveBeenCalledOnce());
    await expect(secondTab.result.current()).rejects.toThrow(/another tab/);
    expect(disable).not.toHaveBeenCalled();
    bind.reject(new Error("response lost"));
    await waitFor(() => expect(disable).toHaveBeenCalledOnce());
    await expect(secondTab.result.current()).rejects.toThrow(/another tab/);
    cleanup.resolve({ removed: true });
    await failed;
    expect(env.subscription).toBeNull();
    enable.mockResolvedValue(undefined);
    await secondTab.result.current();
    expect(env.subscription).not.toBeNull();
    expect(disable).toHaveBeenCalledOnce();
  });

  it("does not compensate a rejected competitor when the first enable succeeds", async () => {
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
    await expect(secondTab.result.current()).rejects.toThrow(/another tab/);
    bind.resolve();
    await first;
    expect(env.subscription).not.toBeNull();
    expect(disable).not.toHaveBeenCalled();
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
