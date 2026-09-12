import { api } from "@pocketcircle/convex";
import { useMutation, useQuery } from "convex/react";
import { MOCKS } from "../env.js";
import {
  clearLocalPushSubscriptionAndBinding,
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
    return async () => {};
  }
  return reconcile;
}

/** Settings enable: permission + subscribe + bind. */
export function useEnableNotifications() {
  const vapid = usePushVapidPublicKey();
  const enable = useEnablePushSubscription();

  return async () => {
    if (!vapid) {
      throw new Error("Push notifications are not configured");
    }
    const material = await subscribeForPushNotifications(vapid);
    try {
      await enable(material);
    } catch (error) {
      // Roll back local sub so the switch does not look enabled without a binding.
      await unsubscribeLocalPushSubscription().catch(() => undefined);
      throw error;
    }
  };
}

/** Settings disable: unsubscribe + unbind; leaves browser permission granted. */
export function useDisableNotifications() {
  const disable = useDisablePushSubscription();

  return async () => {
    const endpoint = await unsubscribeLocalPushSubscription();
    if (endpoint) {
      await disable({ endpoint });
    }
  };
}

export function useClearPushOnSignOut() {
  const disable = useDisablePushSubscription();
  return () => clearLocalPushSubscriptionAndBinding(disable);
}
