import { useEffect, useEffectEvent } from "react";
import { usePushVapidPublicKey, useReconcilePushSubscription } from "~/lib/data.js";
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

  const runReconcile = useEffectEvent(async () => {
    if (!vapid) {
      return;
    }
    const material = await readPushSubscriptionMaterial(vapid.keyId);
    await reconcile({ subscription: material });
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
