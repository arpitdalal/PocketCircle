import { api } from "@pocketcircle/convex";
import { useMutation, useQuery } from "convex/react";
import { track } from "../analytics.js";
import { MOCKS } from "../env.js";
import {
  beginPushEnable,
  clearLocalPushSubscriptionAndBinding,
  disableCurrentPushSubscription,
  endPushEnable,
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
      const material = await subscribeForPushNotifications(vapid);
      try {
        await enable(material);
        track("notifications_enabled", {});
      } catch (error) {
        // Ambiguous transport failures: clear server binding for this endpoint
        // (covers committed-but-lost-response) then drop the local subscription.
        try {
          await disable({ endpoint: material.endpoint });
        } catch {
          // Best-effort compensation.
        }
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
