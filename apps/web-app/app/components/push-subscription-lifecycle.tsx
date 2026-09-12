import { useEffect, useEffectEvent, useRef } from "react";
import {
  useDisablePushSubscription,
  usePushVapidPublicKey,
  useReconcilePushSubscription,
  useReplacePushSubscription,
} from "~/lib/data.js";
import { MOCKS } from "~/lib/env.js";
import {
  isPushEnableInFlight,
  notifyPushSubscriptionChanged,
  readPushSubscriptionMaterial,
  recalledPushEndpoint,
  registerPushServiceWorker,
  rememberPushEndpoint,
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
    await unsubscribeLocalPushSubscription(expectedEndpoint).catch(() => undefined);
    rememberPushEndpoint(null);
    notifyPushSubscriptionChanged();
  });

  const disableDistinctEndpoints = useEffectEvent(async (primary: string) => {
    const remembered = recalledPushEndpoint();
    const endpoints = [...new Set([primary, remembered].filter((value) => value !== null))];
    for (const endpoint of endpoints) {
      try {
        await disable({ endpoint });
      } catch {
        // Best-effort — may no-op if another User owns the row.
      }
    }
  });

  const runReconcile = useEffectEvent(async () => {
    if (!vapid) {
      return;
    }
    try {
      const result = await readPushSubscriptionMaterial(vapid);
      if (result.unboundEndpoint) {
        await disableDistinctEndpoints(result.unboundEndpoint);
        rememberPushEndpoint(null);
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
        // Parallel run may have already migrated — confirm via ordinary reconcile
        // before treating the live endpoint as an orphan.
        const confirmed = await reconcile({ subscription: result.subscription });
        if (confirmed?.bound) {
          rememberPushEndpoint(result.subscription.endpoint);
          notifyPushSubscriptionChanged();
          return;
        }
        await dropOrphanLocal(result.subscription.endpoint);
        return;
      }
      const outcome = await reconcile({ subscription: result.subscription });
      if (!outcome?.bound) {
        // Orphan / other-User / LRU-evicted local sub — clear so UI is not falsely enabled.
        await dropOrphanLocal(result.subscription.endpoint);
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
