import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PushSubscriptionLifecycle } from "~/components/push-subscription-lifecycle.js";
import {
  clearRememberedPushEndpoints,
  recalledPendingPushCleanup,
  rememberPushEndpoint,
  rememberPushEndpoints,
  resetPushOperationState,
  vapidPublicKeyBytes,
} from "~/lib/push-subscriptions.js";
import { AppTestProviders } from "~/test/app-test-providers.js";
import { configureConvex, convexReactMock } from "~/test/convex-react.js";
import { installPushEnv, makeFakePushSubscription, resetPushEnv } from "~/test/push-env.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

const VAPID = { publicKey: "AQID", keyId: "primary" };

function matchingSub(endpoint: string) {
  const sub = makeFakePushSubscription({ endpoint });
  sub.options = { applicationServerKey: vapidPublicKeyBytes(VAPID.publicKey) };
  return sub;
}

function renderLifecycle() {
  return render(
    <AppTestProviders>
      <PushSubscriptionLifecycle />
    </AppTestProviders>,
  );
}

beforeEach(() => {
  convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
  resetPushEnv();
  clearRememberedPushEndpoints();
  resetPushOperationState();
});

afterEach(() => {
  resetPushEnv();
  clearRememberedPushEndpoints();
  resetPushOperationState();
  vi.clearAllMocks();
});

describe("PushSubscriptionLifecycle", () => {
  it("reconciles a matching live subscription on mount", async () => {
    const sub = matchingSub("https://push.example/live");
    installPushEnv({ permission: "granted", subscription: sub });
    rememberPushEndpoint(sub.endpoint);
    const reconcilePushSubscription = vi.fn().mockResolvedValue({ bound: true });
    configureConvex({
      pushVapidPublicKey: VAPID,
      reconcilePushSubscription,
    });

    renderLifecycle();

    await waitFor(() => {
      expect(reconcilePushSubscription).toHaveBeenCalledWith({
        subscription: {
          endpoint: sub.endpoint,
          p256dh: "p256dh-test",
          auth: "auth-test",
          vapidKeyId: VAPID.keyId,
        },
      });
    });
  });

  it("disables and drops an unbound live subscription", async () => {
    const sub = matchingSub("https://push.example/orphan");
    installPushEnv({ permission: "granted", subscription: sub });
    rememberPushEndpoint(sub.endpoint);
    const reconcilePushSubscription = vi.fn().mockResolvedValue({ bound: false });
    const disablePushSubscription = vi.fn().mockResolvedValue({ removed: false });
    configureConvex({
      pushVapidPublicKey: VAPID,
      reconcilePushSubscription,
      disablePushSubscription,
    });

    renderLifecycle();

    await waitFor(() => {
      // Confirm-before-drop: unbound reconcile runs at least twice.
      expect(reconcilePushSubscription.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(sub.unsubscribe).toHaveBeenCalled();
    });
    // Foreign/unbound — keep pending retry handle after local drop.
    expect(recalledPendingPushCleanup()).toEqual([sub.endpoint]);
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBeNull();
  });

  it("retries pending cleanup while an active subscription stays bound", async () => {
    const sub = matchingSub("https://push.example/live");
    installPushEnv({ permission: "granted", subscription: sub });
    rememberPushEndpoint(sub.endpoint);
    rememberPushEndpoints(["https://push.example/stale"]);
    const reconcilePushSubscription = vi.fn().mockResolvedValue({ bound: true });
    const disablePushSubscription = vi.fn().mockResolvedValue({ removed: true });
    configureConvex({
      pushVapidPublicKey: VAPID,
      reconcilePushSubscription,
      disablePushSubscription,
    });

    renderLifecycle();

    await waitFor(() => {
      expect(disablePushSubscription).toHaveBeenCalledWith({
        endpoint: "https://push.example/stale",
      });
    });
    await waitFor(() => {
      expect(recalledPendingPushCleanup()).toEqual([]);
    });
    expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBe(sub.endpoint);
    expect(sub.unsubscribe).not.toHaveBeenCalled();
  });

  it("disables the remembered active endpoint when the local subscription is absent", async () => {
    installPushEnv({ permission: "granted", subscription: null });
    rememberPushEndpoint("https://push.example/absent");
    const disablePushSubscription = vi.fn().mockResolvedValue({ removed: true });
    configureConvex({
      pushVapidPublicKey: VAPID,
      disablePushSubscription,
      reconcilePushSubscription: vi.fn(),
    });

    renderLifecycle();

    await waitFor(() => {
      expect(disablePushSubscription).toHaveBeenCalledWith({
        endpoint: "https://push.example/absent",
      });
    });
    await waitFor(() => {
      expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBeNull();
    });
  });

  it("does not clear active remember when orphan drop finds a different live endpoint", async () => {
    const a = matchingSub("https://push.example/a");
    const b = matchingSub("https://push.example/b");
    let live: ReturnType<typeof matchingSub> | null = a;
    installPushEnv({
      permission: "granted",
      subscription: a,
      getSubscription: vi.fn(async () => live),
    });
    rememberPushEndpoint(a.endpoint);
    const reconcilePushSubscription = vi.fn().mockImplementation(async () => {
      live = b;
      rememberPushEndpoint(b.endpoint);
      return { bound: false };
    });
    configureConvex({
      pushVapidPublicKey: VAPID,
      reconcilePushSubscription,
      disablePushSubscription: vi.fn().mockResolvedValue({ removed: false }),
    });

    renderLifecycle();

    await waitFor(() => {
      expect(reconcilePushSubscription.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(() => {
      expect(window.localStorage.getItem("pocketcircle.lastPushEndpoint")).toBe(b.endpoint);
    });
    expect(a.unsubscribe).not.toHaveBeenCalled();
    expect(b.unsubscribe).not.toHaveBeenCalled();
    expect(recalledPendingPushCleanup()).toEqual([a.endpoint]);
  });
});
