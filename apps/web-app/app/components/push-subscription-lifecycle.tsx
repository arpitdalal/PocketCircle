import { useEffect, useEffectEvent } from "react";
import {
  useDisablePushSubscription,
  usePushVapidPublicKey,
  useReconcilePushSubscription,
  useReplacePushSubscription,
} from "~/lib/data.js";
import { MOCKS } from "~/lib/env.js";
import {
  notifyPushSubscriptionChanged,
  readPushSubscriptionMaterial,
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

  const dropOrphanLocal = useEffectEvent(async (expectedEndpoint: string) => {
    await unsubscribeLocalPushSubscription(expectedEndpoint).catch(() => undefined);
    rememberPushEndpoint(null);
    notifyPushSubscriptionChanged();
  });

  const runReconcile = useEffectEvent(async () => {
    if (!vapid) {
      return;
    }
    try {
      const result = await readPushSubscriptionMaterial(vapid);
      if (result.unboundEndpoint) {
        try {
          await disable({ endpoint: result.unboundEndpoint });
        } catch {
          // Best-effort — may no-op if another User owns the row.
        }
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
        if (!outcome?.bound) {
          await dropOrphanLocal(result.subscription.endpoint);
          return;
        }
        rememberPushEndpoint(result.subscription.endpoint);
        notifyPushSubscriptionChanged();
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

  useEffect(() => {
    if (MOCKS) {
      return;
    }
    void registerPushServiceWorker();
    const onFocus = () => {
      void runReconcile();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void runReconcile();
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
    void runReconcile();
  }, [vapid]);

  return null;
}
