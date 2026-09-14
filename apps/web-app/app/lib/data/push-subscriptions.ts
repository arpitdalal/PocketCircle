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
  /** Fires immediately before a unique `enable` claim (not after replace migrate). */
  onUniqueEnableAttempt?: () => void,
) {
  if (previousEndpoint && previousEndpoint !== material.endpoint) {
    const result = await replace({ previousEndpoint, ...material });
    if (result?.bound) {
      // Migrated an already-owned row onto next — not a uniquely created bind.
      return "replace" as const;
    }
    // Replace refused — enable may still rebind next; drop previous if we own it
    // so remigrate does not leave two rows toward the 10-cap.
    onUniqueEnableAttempt?.();
    await enable(material);
    await disableOrRememberPending(disable, previousEndpoint);
    return "enable" as const;
  }
  onUniqueEnableAttempt?.();
  await enable(material);
  return "enable" as const;
}

/** One ownership probe: true / false / unknown (query failure — do not compensate). */
async function probePushEndpointOwnership(owns: OwnsPush, endpoint: string) {
  try {
    return !!(await owns(endpoint));
  } catch {
    return "unknown" as const;
  }
}

/** Compensate only endpoints this attempt may have uniquely bound. */
async function compensateFailedBind(
  disable: (args: { endpoint: string }) => Promise<unknown>,
  endpoints: string[],
  localEndpoint: string | undefined,
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
  if (!localEndpoint || !unique.includes(localEndpoint)) {
    return;
  }
  // Prefer the known live bind endpoint; if a concurrent tab already replaced
  // it, only drop the live sub when it is still one of our compensate targets.
  const dropped = await unsubscribeLocalPushSubscription(localEndpoint).catch(() => undefined);
  if (dropped?.status === "mismatch") {
    const live = await getCurrentPushSubscription();
    if (live && unique.includes(live.endpoint)) {
      await unsubscribeLocalPushSubscription(live.endpoint).catch(() => undefined);
    }
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
        /** Endpoints this attempt uniquely bound — compensate these even if a
         * later recovery endpoint is peer-owned / ownership-unknown. */
        const toCompensate = new Set<string>();
        let bindAttempted = false;
        try {
          assertCurrentOperation();
          const ownedFirst = await probePushEndpointOwnership(owns, binding.endpoint);
          assertCurrentOperation();
          bindAttempted = true;
          await bindPushSubscription(enable, replace, disable, binding, previousEndpoint, () => {
            // Mark before enable awaits so a thrown enable still compensates.
            // Replace-migrate never calls this.
            if (ownedFirst === false) {
              toCompensate.add(binding.endpoint);
            }
          });
          assertCurrentOperation();
          // The browser may revoke or refresh its subscription during bind; recover once.
          const live = await getCurrentPushSubscription();
          if (!live || live.endpoint !== binding.endpoint) {
            const firstEndpoint = binding.endpoint;
            const recovered = await subscribeForPushNotifications(
              vapid,
              permission,
              assertCurrentOperation,
            );
            binding = recovered.material;
            material = binding;
            previousEndpoint = recovered.previousEndpoint ?? firstEndpoint;
            assertCurrentOperation();
            const ownedSecond = await probePushEndpointOwnership(owns, binding.endpoint);
            assertCurrentOperation();
            bindAttempted = true;
            await bindPushSubscription(enable, replace, disable, binding, previousEndpoint, () => {
              if (ownedSecond === false) {
                toCompensate.add(binding.endpoint);
              }
            });
            assertCurrentOperation();
            const after = await getCurrentPushSubscription();
            if (!after || after.endpoint !== binding.endpoint) {
              throw new Error("Push subscription was removed during enable");
            }
            // Drop the abandoned first endpoint (or keep pending on failure).
            if (firstEndpoint !== binding.endpoint) {
              await disableOrRememberPending(disable, firstEndpoint);
              toCompensate.delete(firstEndpoint);
            }
          }
          assertCurrentOperation();
          bound = true;
          track("notifications_enabled", {});
        } catch (error) {
          if (!bindAttempted || toCompensate.size === 0) {
            throw error;
          }
          // Ambiguous transport failures: clear server bindings we uniquely
          // attempted, then drop the local sub only if it is one of those.
          const local = binding.endpoint;
          await compensateFailedBind(
            disable,
            [...toCompensate],
            toCompensate.has(local) ? local : undefined,
          );
          throw error;
        }
      },
      { wait: true },
    );
  } catch (error) {
    // Subscribe ran before the lock — local sub is shared with any peer. Never
    // unsubscribe on ordinary bind failure; bind-path compensation under the
    // lock owns that teardown. Sign-out/cancel is different: cleanup may have
    // snapshotted before subscribe resolved, so tear down the unbound local sub.
    if (!bound && material) {
      // Soft-clear / cancel unsub only when ownership is confirmed false.
      // owns() failure → unknown → leave the shared local sub alone.
      const owned = await probePushEndpointOwnership(owns, material.endpoint);
      if (owned === false) {
        rememberPushEndpoint(null);
        if (cancelled() || isPushEnableCancelRequested()) {
          await unsubscribeLocalPushSubscription(material.endpoint).catch(() => undefined);
        }
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
