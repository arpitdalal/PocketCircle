import { api } from "@pocketcircle/convex";
import { useMutation, useQuery } from "convex/react";
import { MOCKS } from "../env.js";
import {
  clearLocalPushSubscriptionAndBinding,
  subscribeForPushNotifications,
  unsubscribeLocalPushSubscription,
} from "../push-subscriptions.js";

export function usePushVapidPublicKey() {
  return useQuery(api.pushSubscriptions.getPushVapidPublicKey, MOCKS ? "skip" : {});
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
    await enable(material);
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
