import { useEffect, useEffectEvent } from "react";
import {
  useDisablePushSubscription,
  usePushVapidPublicKey,
  useReconcilePushSubscription,
} from "~/lib/data.js";
import { MOCKS } from "~/lib/env.js";
import {
  readPushSubscriptionMaterial,
  registerPushServiceWorker,
} from "~/lib/push-subscriptions.js";

/**
 * Registers the Push SW (outside MOCKS) and reconciles the browser subscription
 * on mount + focus/visibility — never requests notification permission (#381).
 */
export function PushSubscriptionLifecycle() {
  const vapid = usePushVapidPublicKey();
  const reconcile = useReconcilePushSubscription();
  const disable = useDisablePushSubscription();

  const runReconcile = useEffectEvent(async () => {
    if (!vapid) {
      return;
    }
    const result = await readPushSubscriptionMaterial(vapid);
    if (result.unboundEndpoint) {
      try {
        await disable({ endpoint: result.unboundEndpoint });
      } catch {
        // Best-effort: still reconcile the replacement if any.
      }
    }
    await reconcile({ subscription: result.subscription });
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
