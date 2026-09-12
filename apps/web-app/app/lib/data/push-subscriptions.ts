import { api } from "@pocketcircle/convex";
import { useMutation, useQuery } from "convex/react";
import { track } from "../analytics.js";
import { MOCKS } from "../env.js";
import {
  assertOrphanDropIdleForEnable,
  beginPushEnable,
  clearLocalPushSubscriptionAndBinding,
  disableCurrentPushSubscription,
  endPushEnable,
  getCurrentPushSubscription,
  isPushEnableCancelRequested,
  recalledPendingPushCleanup,
  rememberPushEndpoint,
  rememberPushEndpoints,
  subscribeForPushNotifications,
  unsubscribeLocalPushSubscription,
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

function assertEnableNotCancelled() {
  if (isPushEnableCancelRequested()) {
    throw new Error("push enable cancelled");
  }
}

function outcomeRemoved(outcome: unknown) {
  return (
    typeof outcome === "object" &&
    outcome !== null &&
    "removed" in outcome &&
    outcome.removed === true
  );
}

/** Disable endpoint or retain a pending cleanup handle. */
async function disableOrRememberPending(
  disable: (args: { endpoint: string }) => Promise<unknown>,
  endpoint: string,
) {
  let removed = false;
  try {
    removed = outcomeRemoved(await disable({ endpoint }));
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

/** Settings enable: permission + subscribe + bind. */
export function useEnableNotifications() {
  const vapid = usePushVapidPublicKey();
  const enable = useEnablePushSubscription();
  const disable = useDisablePushSubscription();

  return async () => {
    if (!vapid) {
      throw new Error("Push notifications are not configured");
    }
    beginPushEnable();
    try {
      assertEnableNotCancelled();
      // Fail fast — waiting would burn the user-activation window (iOS/Safari).
      assertOrphanDropIdleForEnable();
      assertEnableNotCancelled();
      let material = await subscribeForPushNotifications(vapid);
      /** First bind that recovery abandoned — catch must unbind it too. */
      let abandonedEndpoint: string | undefined;
      try {
        assertEnableNotCancelled();
        await enable(material);
        assertEnableNotCancelled();
        // Orphan drop may have unsubscribed during bind — recover once.
        const live = await getCurrentPushSubscription();
        if (!live || live.endpoint !== material.endpoint) {
          const previousEndpoint = material.endpoint;
          // First bind may have committed — catch must unbind it if recovery fails.
          abandonedEndpoint = previousEndpoint;
          material = await subscribeForPushNotifications(vapid);
          assertEnableNotCancelled();
          await enable(material);
          assertEnableNotCancelled();
          const recovered = await getCurrentPushSubscription();
          if (!recovered || recovered.endpoint !== material.endpoint) {
            throw new Error("Push subscription was removed during enable");
          }
          // Drop the abandoned first endpoint (or keep pending on failure).
          if (previousEndpoint !== material.endpoint) {
            await disableOrRememberPending(disable, previousEndpoint);
          }
          abandonedEndpoint = undefined;
        }
        assertEnableNotCancelled();
        track("notifications_enabled", {});
      } catch (error) {
        // Ambiguous transport failures: clear server binding for this endpoint
        // (covers committed-but-lost-response) then drop the local subscription.
        const endpoints = [
          ...new Set(
            [material.endpoint, abandonedEndpoint].filter(
              (endpoint): endpoint is string => typeof endpoint === "string" && endpoint.length > 0,
            ),
          ),
        ];
        const failures: string[] = [];
        for (const endpoint of endpoints) {
          let removed = false;
          try {
            removed = outcomeRemoved(await disable({ endpoint }));
          } catch {
            removed = false;
          }
          if (!removed) {
            failures.push(endpoint);
          }
        }
        rememberPushEndpoint(null);
        rememberPushEndpoints([
          ...recalledPendingPushCleanup().filter((endpoint) => !endpoints.includes(endpoint)),
          ...failures,
        ]);
        await unsubscribeLocalPushSubscription(material.endpoint).catch(() => undefined);
        throw error;
      }
    } finally {
      endPushEnable();
    }
  };
}

/** Settings disable: unsubscribe + unbind; leaves browser permission granted. */
export function useDisableNotifications() {
  const disable = useDisablePushSubscription();

  return async () => {
    await disableCurrentPushSubscription(disable);
    track("notifications_disabled", {});
  };
}

export function useClearPushOnSignOut() {
  const disable = useDisablePushSubscription();
  return () => clearLocalPushSubscriptionAndBinding(disable);
}
