import { api } from "@pocketcircle/convex";
import { useConvex, useMutation, useQuery } from "convex/react";
import { track } from "../analytics.js";
import { MOCKS } from "../env.js";
import {
  applyPendingCleanupFlushResult,
  beginPushEnable,
  capturePushCancellation,
  clearLocalPushSubscriptionAndBinding,
  disableCurrentPushSubscription,
  disableRemovedOwnedBinding,
  endPushEnable,
  ensureActivePushServiceWorker,
  getCurrentPushSubscription,
  isPushEnableCancelRequested,
  type PushSubscriptionMaterial,
  recalledPendingPushCleanup,
  rememberPushEndpoint,
  rememberPushEndpoints,
  requestPushNotificationPermission,
  subscribeForPushNotifications,
  unsubscribeLocalPushSubscription,
  withPushSubscriptionLock,
} from "../push-subscriptions.js";

export function usePushVapidPublicKey() {
  const vapid = useQuery(api.pushSubscriptions.getPushVapidPublicKey, MOCKS ? "skip" : {});
  // `skip` yields undefined; Settings treats undefined as still-loading. MOCKS
  // has no Push SW — surface "unsupported" via null once the card can render.
  return MOCKS ? null : vapid;
}

export function useEnablePushSubscription() {
  const enable = useMutation(api.pushSubscriptions.enablePushSubscription);
  if (MOCKS) {
    return async () => {};
  }
  return enable;
}

export function useDisablePushSubscription() {
  const disable = useMutation(api.pushSubscriptions.disablePushSubscription);
  if (MOCKS) {
    return async () => {};
  }
  return disable;
}

export function useReconcilePushSubscription() {
  const reconcile = useMutation(api.pushSubscriptions.reconcilePushSubscription);
  if (MOCKS) {
    return async () => ({ bound: false });
  }
  return reconcile;
}

export function useReplacePushSubscription() {
  const replace = useMutation(api.pushSubscriptions.replacePushSubscription);
  if (MOCKS) {
    return async () => ({ bound: false });
  }
  return replace;
}

/** One-shot ownership check for VAPID-mismatch reconcile (account switch). */
export function useOwnsPushEndpoint() {
  const convex = useConvex();
  if (MOCKS) {
    return async (_endpoint: string) => false;
  }
  return (endpoint: string) => convex.query(api.pushSubscriptions.ownsPushEndpoint, { endpoint });
}

/** Refresh lastSeenAt for an owned endpoint (old-key reconcile path). */
export function useTouchPushSubscription() {
  const touch = useMutation(api.pushSubscriptions.touchPushSubscription);
  if (MOCKS) {
    return async () => ({ touched: false });
  }
  return touch;
}

function assertEnableNotCancelled() {
  if (isPushEnableCancelRequested()) {
    throw new Error("push enable cancelled");
  }
}

/** Disable endpoint or retain a pending cleanup handle. */
async function disableOrRememberPending(
  disable: (args: { endpoint: string }) => Promise<unknown>,
  endpoint: string,
) {
  let removed = false;
  try {
    removed = disableRemovedOwnedBinding(await disable({ endpoint }));
  } catch {
    removed = false;
  }
  if (!removed) {
    rememberPushEndpoints([
      ...recalledPendingPushCleanup().filter((value) => value !== endpoint),
      endpoint,
    ]);
  }
  return removed;
}

type BindPush = (material: PushSubscriptionMaterial) => Promise<unknown>;
type ReplacePush = (
  args: PushSubscriptionMaterial & { previousEndpoint: string },
) => Promise<{ bound: boolean }>;
type OwnsPush = (endpoint: string) => Promise<boolean>;

/** Bind via replace when remigrating an owned old-key endpoint; else enable. */
async function bindPushSubscription(
  enable: BindPush,
  replace: ReplacePush,
  disable: (args: { endpoint: string }) => Promise<unknown>,
  material: PushSubscriptionMaterial,
  previousEndpoint: string | undefined,
) {
  if (previousEndpoint && previousEndpoint !== material.endpoint) {
    const result = await replace({ previousEndpoint, ...material });
    if (result?.bound) {
      return;
    }
    // Replace refused — enable may still rebind next; drop previous if we own it
    // so remigrate does not leave two rows toward the 10-cap.
    await enable(material);
    await disableOrRememberPending(disable, previousEndpoint);
    return;
  }
  await enable(material);
}

/** Compensate only endpoints this attempt may have uniquely bound. */
async function compensateFailedBind(
  disable: (args: { endpoint: string }) => Promise<unknown>,
  endpoints: string[],
) {
  const unique = [...new Set(endpoints.filter((endpoint) => endpoint.length > 0))];
  const failures: string[] = [];
  for (const endpoint of unique) {
    let removed = false;
    try {
      removed = disableRemovedOwnedBinding(await disable({ endpoint }));
    } catch {
      removed = false;
    }
    if (!removed) {
      failures.push(endpoint);
    }
  }
  rememberPushEndpoint(null);
  applyPendingCleanupFlushResult(unique, failures);
  const local = unique[unique.length - 1];
  if (local) {
    await unsubscribeLocalPushSubscription(local).catch(() => undefined);
  }
}

/** One complete enable transaction; the hook only supplies the network boundary. */
async function enableNotifications(
  vapid: { publicKey: string; keyId: string } | null | undefined,
  enable: BindPush,
  disable: (args: { endpoint: string }) => Promise<unknown>,
  replace: ReplacePush,
  owns: OwnsPush,
) {
  if (!vapid) {
    throw new Error("Push notifications are not configured");
  }
  const cancelled = capturePushCancellation();
  const assertCurrentOperation = () => {
    if (cancelled()) throw new Error("push enable cancelled");
    assertEnableNotCancelled();
  };
  // Invoke in the click stack; acquiring a Web Lock crosses a task boundary and
  // drops user activation (Safari iOS / Firefox). Subscribe before the lock.
  // Kick permission + display-SW update together so remigrate keeps gesture budget.
  const permission = requestPushNotificationPermission();
  const ensuredPending = ensureActivePushServiceWorker();
  // A busy lock can reject before the permission promise settles.
  void permission.catch(() => undefined);
  beginPushEnable();
  let material: PushSubscriptionMaterial | undefined;
  let previousEndpoint: string | undefined;
  let bound = false;
  try {
    assertCurrentOperation();
    const subscribed = await subscribeForPushNotifications(
      vapid,
      permission,
      assertCurrentOperation,
      ensuredPending,
    );
    material = subscribed.material;
    previousEndpoint = subscribed.previousEndpoint;
    let binding = material;
    // Wait for the lock — do not use ifAvailable after a successful local
    // subscribe (that would orphan an unbound sub or race another tab's unsub).
    await withPushSubscriptionLock(
      async () => {
        if (cancelled()) throw new Error("push enable cancelled");
        assertCurrentOperation();
        /** First bind that recovery abandoned — catch must unbind it too. */
        let abandonedEndpoint: string | undefined;
        /** Peer/prior already owns this endpoint — never destroy their bind. */
        let ownedBeforeEnable = false;
        try {
          assertCurrentOperation();
          ownedBeforeEnable = await owns(binding.endpoint);
          assertCurrentOperation();
          await bindPushSubscription(enable, replace, disable, binding, previousEndpoint);
          assertCurrentOperation();
          // The browser may revoke or refresh its subscription during bind; recover once.
          const live = await getCurrentPushSubscription();
          if (!live || live.endpoint !== binding.endpoint) {
            const firstEndpoint = binding.endpoint;
            // First bind may have committed — catch must unbind it if recovery fails.
            abandonedEndpoint = firstEndpoint;
            const recovered = await subscribeForPushNotifications(
              vapid,
              permission,
              assertCurrentOperation,
            );
            binding = recovered.material;
            material = binding;
            previousEndpoint = recovered.previousEndpoint ?? firstEndpoint;
            assertCurrentOperation();
            ownedBeforeEnable = await owns(binding.endpoint);
            assertCurrentOperation();
            await bindPushSubscription(enable, replace, disable, binding, previousEndpoint);
            assertCurrentOperation();
            const after = await getCurrentPushSubscription();
            if (!after || after.endpoint !== binding.endpoint) {
              throw new Error("Push subscription was removed during enable");
            }
            // Drop the abandoned first endpoint (or keep pending on failure).
            if (firstEndpoint !== binding.endpoint) {
              await disableOrRememberPending(disable, firstEndpoint);
            }
            abandonedEndpoint = undefined;
          }
          assertCurrentOperation();
          bound = true;
          track("notifications_enabled", {});
        } catch (error) {
          if (ownedBeforeEnable) {
            // Concurrent peer already bound this endpoint — leave their sub alone.
            throw error;
          }
          // Ambiguous transport failures: clear server binding for this endpoint
          // (covers committed-but-lost-response) then drop the local subscription.
          await compensateFailedBind(disable, [binding.endpoint, abandonedEndpoint ?? ""]);
          throw error;
        }
      },
      { wait: true },
    );
  } catch (error) {
    // Subscribe ran before the lock — local sub is shared with any peer. Never
    // unsubscribe here; bind-path compensation under the lock owns teardown.
    if (!bound && material) {
      // Soft-clear remember only when nobody owns the endpoint yet.
      const owned = await owns(material.endpoint).catch(() => false);
      if (!owned) {
        rememberPushEndpoint(null);
      }
    }
    throw error;
  } finally {
    endPushEnable();
  }
}

/** Settings enable: permission + subscribe + bind (replace on VAPID remigrate). */
export function useEnableNotifications() {
  const vapid = usePushVapidPublicKey();
  const enable = useEnablePushSubscription();
  const disable = useDisablePushSubscription();
  const replace = useReplacePushSubscription();
  const owns = useOwnsPushEndpoint();
  return () => enableNotifications(vapid, enable, disable, replace, owns);
}

/** Settings disable: unsubscribe + unbind; leaves browser permission granted. */
export function useDisableNotifications() {
  const disable = useDisablePushSubscription();

  return async () => {
    await withPushSubscriptionLock(() => disableCurrentPushSubscription(disable));
    track("notifications_disabled", {});
  };
}

export function useClearPushOnSignOut() {
  const disable = useDisablePushSubscription();
  return () => clearLocalPushSubscriptionAndBinding(disable);
}
