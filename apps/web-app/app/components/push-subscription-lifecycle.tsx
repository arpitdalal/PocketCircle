import { useEffect, useEffectEvent } from "react";
import {
  useDisablePushSubscription,
  useOwnsPushEndpoint,
  usePushVapidPublicKey,
  useReconcilePushSubscription,
  useReplacePushSubscription,
  useTouchPushSubscription,
} from "~/lib/data.js";
import { MOCKS } from "~/lib/env.js";
import {
  applyPendingCleanupFlushResult,
  capturePushCancellation,
  notifyPushSubscriptionChanged,
  readPushSubscriptionMaterial,
  recalledPendingPushCleanup,
  recalledPushEndpoint,
  recordOrphanLocalDrop,
  registerPushServiceWorker,
  rememberPushEndpoint,
  rememberPushEndpoints,
  unsubscribeLocalPushSubscription,
  withPushSubscriptionLock,
} from "~/lib/push-subscriptions.js";

/** Reconcile under the same browser lock as enable, disable, and sign-out. */
export function PushSubscriptionLifecycle() {
  const vapid = usePushVapidPublicKey();
  const reconcile = useReconcilePushSubscription();
  const replace = useReplacePushSubscription();
  const disable = useDisablePushSubscription();
  const ownsPushEndpoint = useOwnsPushEndpoint();
  const touch = useTouchPushSubscription();

  const runReconcile = useEffectEvent(async (isCancelled: () => boolean) => {
    if (!vapid || isCancelled()) return;

    const disableEndpoints = async (endpoints: string[]) => {
      const attempted = [...new Set(endpoints)];
      rememberPushEndpoints(attempted);
      for (const endpoint of attempted) {
        if (isCancelled()) return;
        try {
          const outcome = await disable({ endpoint });
          if (isCancelled()) return;
          if (outcome?.removed) applyPendingCleanupFlushResult([endpoint], []);
        } catch {
          // The retry record was persisted before the request.
        }
      }
    };

    const result = await readPushSubscriptionMaterial(vapid, isCancelled);
    if (isCancelled()) return;
    if (result.unboundEndpoint) {
      const endpoints = result.unboundEndpoints;
      await disableEndpoints(endpoints);
      if (isCancelled()) return;
      const active = recalledPushEndpoint();
      if (active && endpoints.includes(active)) rememberPushEndpoint(null);
      notifyPushSubscriptionChanged();
      return;
    }
    if (!result.subscription) {
      if (result.staleKeyEndpoint) {
        // Old VAPID key still on the browser. Keep it only when this User owns
        // the endpoint (dual-key delivery). Fail closed on ownership lookup
        // errors — drop local so a previous User's sub cannot keep delivering
        // after switch, but remember pending cleanup so *our* server row is not
        // orphaned when the lookup was only transiently broken.
        let ownership: "owned" | "foreign" | "unknown" = "unknown";
        try {
          ownership = (await ownsPushEndpoint(result.staleKeyEndpoint)) ? "owned" : "foreign";
        } catch {
          ownership = "unknown";
        }
        if (isCancelled()) return;
        if (ownership === "owned") {
          // Do not reconcile with the current key id — that would break dual-VAPID
          // send for this row. Only refresh LRU so active devices stay.
          try {
            await touch({ endpoint: result.staleKeyEndpoint });
          } catch {
            // Soft: next focus retries; delivery still works on the old key.
          }
          if (isCancelled()) return;
          rememberPushEndpoint(result.staleKeyEndpoint);
          notifyPushSubscriptionChanged();
        } else {
          const dropped = await unsubscribeLocalPushSubscription(
            result.staleKeyEndpoint,
            isCancelled,
          );
          if (isCancelled() || dropped.status === "mismatch") return;
          if (ownership === "unknown") {
            recordOrphanLocalDrop(result.staleKeyEndpoint);
          } else {
            const active = recalledPushEndpoint();
            if (active === result.staleKeyEndpoint) rememberPushEndpoint(null);
          }
          notifyPushSubscriptionChanged();
        }
      }
      await disableEndpoints(recalledPendingPushCleanup());
      return;
    }
    const subscription = result.subscription;
    let outcome = result.previousEndpoint
      ? await replace({ previousEndpoint: result.previousEndpoint, ...subscription })
      : await reconcile({ subscription });
    if (isCancelled()) return;
    // Another run may already have migrated the old row to this endpoint.
    if (!outcome?.bound) {
      outcome = await reconcile({ subscription });
      if (isCancelled()) return;
    }
    if (!outcome?.bound) {
      const dropped = await unsubscribeLocalPushSubscription(subscription.endpoint, isCancelled);
      if (isCancelled() || dropped.status === "mismatch") return;
      recordOrphanLocalDrop(subscription.endpoint);
    } else {
      rememberPushEndpoint(subscription.endpoint);
    }
    notifyPushSubscriptionChanged();
    await disableEndpoints(
      recalledPendingPushCleanup().filter((endpoint) => endpoint !== subscription.endpoint),
    );
  });

  useEffect(() => {
    if (MOCKS || !vapid) return;
    const abort = new AbortController();
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      const signOutCancelled = capturePushCancellation();
      const isCancelled = () => abort.signal.aborted || signOutCancelled();
      void withPushSubscriptionLock(() => runReconcile(isCancelled), {
        wait: true,
        signal: abort.signal,
      })
        .catch(() => undefined)
        .finally(() => {
          scheduled = false;
        });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") schedule();
    };
    void registerPushServiceWorker();
    schedule();
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      abort.abort();
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [vapid]);

  return null;
}
