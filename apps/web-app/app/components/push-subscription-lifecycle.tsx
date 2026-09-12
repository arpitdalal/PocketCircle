import { useEffect, useEffectEvent, useRef } from "react";
import {
  useDisablePushSubscription,
  usePushVapidPublicKey,
  useReconcilePushSubscription,
  useReplacePushSubscription,
} from "~/lib/data.js";
import { MOCKS } from "~/lib/env.js";
import {
  clearRememberedPushEndpoints,
  isPushEnableInFlight,
  notifyPushSubscriptionChanged,
  readPushSubscriptionMaterial,
  registerPushServiceWorker,
  rememberPushEndpoint,
  rememberPushEndpoints,
  unsubscribeLocalPushSubscription,
} from "~/lib/push-subscriptions.js";

/**
 * Registers the Push SW (outside MOCKS) and reconciles the browser subscription
 * on mount + focus/visibility — never requests notification permission (#381).
 */
export function PushSubscriptionLifecycle() {
  const vapid = usePushVapidPublicKey();
  const reconcile = useReconcilePushSubscription();
  const replace = useReplacePushSubscription();
  const disable = useDisablePushSubscription();
  /** Serialize focus+visibility overlap so a second replace cannot orphan a successful first. */
  const reconcileChain = useRef(Promise.resolve());

  const dropOrphanLocal = useEffectEvent(async (expectedEndpoint: string) => {
    if (isPushEnableInFlight()) {
      return;
    }
    try {
      await unsubscribeLocalPushSubscription(expectedEndpoint);
    } catch {
      // Keep remembered state — Settings would otherwise show enabled with no binding.
      return;
    }
    rememberPushEndpoint(null);
    notifyPushSubscriptionChanged();
  });

  /** Reconfirm before drop — an enable may have committed after an unbound response. */
  const dropIfStillUnbound = useEffectEvent(
    async (subscription: {
      endpoint: string;
      p256dh: string;
      auth: string;
      vapidKeyId: string;
    }) => {
      if (isPushEnableInFlight()) {
        return;
      }
      const confirmed = await reconcile({ subscription });
      if (confirmed?.bound) {
        rememberPushEndpoint(subscription.endpoint);
        notifyPushSubscriptionChanged();
        return;
      }
      if (isPushEnableInFlight()) {
        return;
      }
      await dropOrphanLocal(subscription.endpoint);
    },
  );

  const disableCapturedEndpoints = useEffectEvent(async (endpoints: string[]) => {
    // Use only the caller's snapshot — never re-read storage mid-cleanup
    // (another tab may have enabled and remembered a new endpoint).
    if (isPushEnableInFlight()) {
      return [...new Set(endpoints.filter((value) => value.length > 0))];
    }
    const unique = [...new Set(endpoints.filter((value) => value.length > 0))];
    const failures: string[] = [];
    for (const endpoint of unique) {
      try {
        const outcome = await disable({ endpoint });
        if (
          !(
            typeof outcome === "object" &&
            outcome !== null &&
            "removed" in outcome &&
            outcome.removed === true
          )
        ) {
          failures.push(endpoint);
        }
      } catch {
        failures.push(endpoint);
      }
    }
    return failures;
  });

  const runReconcile = useEffectEvent(async () => {
    if (!vapid) {
      return;
    }
    try {
      const result = await readPushSubscriptionMaterial(vapid);
      if (result.unboundEndpoint) {
        if (isPushEnableInFlight()) {
          return;
        }
        const failures = await disableCapturedEndpoints([
          result.unboundEndpoint,
          ...(result.unboundEndpoints ?? []),
        ]);
        if (failures.length === 0) {
          clearRememberedPushEndpoints();
        } else {
          // Keep every failed endpoint so a later focus can retry unbind.
          rememberPushEndpoint(null);
          rememberPushEndpoints(failures);
        }
        notifyPushSubscriptionChanged();
        return;
      }
      if (!result.subscription) {
        return;
      }
      if (result.previousEndpoint) {
        const outcome = await replace({
          previousEndpoint: result.previousEndpoint,
          ...result.subscription,
        });
        if (outcome?.bound) {
          rememberPushEndpoint(result.subscription.endpoint);
          notifyPushSubscriptionChanged();
          return;
        }
        // Parallel run may have already migrated — reconfirm before orphan drop.
        await dropIfStillUnbound(result.subscription);
        return;
      }
      const outcome = await reconcile({ subscription: result.subscription });
      if (!outcome?.bound) {
        // Orphan / other-User / LRU-evicted — reconfirm first in case enable just committed.
        await dropIfStillUnbound(result.subscription);
      }
    } catch {
      // Best-effort lifecycle — never surface unhandled rejections on focus.
    }
  });

  const enqueueReconcile = useEffectEvent(() => {
    reconcileChain.current = reconcileChain.current
      .then(() => runReconcile())
      .catch(() => undefined);
  });

  useEffect(() => {
    if (MOCKS) {
      return;
    }
    void registerPushServiceWorker();
    const onFocus = () => {
      enqueueReconcile();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        enqueueReconcile();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    if (MOCKS || !vapid) {
      return;
    }
    enqueueReconcile();
  }, [vapid]);

  return null;
}
