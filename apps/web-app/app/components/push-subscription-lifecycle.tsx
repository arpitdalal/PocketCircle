import { useEffect, useEffectEvent, useRef } from "react";
import {
  useDisablePushSubscription,
  usePushVapidPublicKey,
  useReconcilePushSubscription,
  useReplacePushSubscription,
} from "~/lib/data.js";
import { MOCKS } from "~/lib/env.js";
import {
  applyPendingCleanupFlushResult,
  beginOrphanDrop,
  endOrphanDrop,
  isPushEnableInFlight,
  notifyPushSubscriptionChanged,
  readPushSubscriptionMaterial,
  recalledPendingPushCleanup,
  recalledPushEndpoint,
  recordOrphanLocalDrop,
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
  /** Bumped on unmount so in-flight reconcile cannot drop a later session's sub. */
  const lifecycleGeneration = useRef(0);

  const dropOrphanLocal = useEffectEvent(async (expectedEndpoint: string) => {
    // Mark busy before the enable check so another tab's enable fails fast
    // instead of racing an already-started unsubscribe.
    beginOrphanDrop();
    try {
      if (isPushEnableInFlight()) {
        return;
      }
      const result = await unsubscribeLocalPushSubscription(expectedEndpoint, {
        abortIfEnableInFlight: true,
      });
      // Live sub moved to a different endpoint — leave B's remember alone.
      if (result.status === "mismatch") {
        return;
      }
      // Enable may have committed during unsubscribe — do not wipe its remember.
      if (isPushEnableInFlight()) {
        return;
      }
      // Absent or unsubscribed expected endpoint — keep pending for server unbind.
      recordOrphanLocalDrop(expectedEndpoint);
      notifyPushSubscriptionChanged();
    } catch {
      // Lookup failure or enable raced in — keep remembered / live state.
    } finally {
      endOrphanDrop();
    }
  });

  /** Reconfirm before drop — an enable may have committed after an unbound response. */
  const dropIfStillUnbound = useEffectEvent(
    async (
      subscription: {
        endpoint: string;
        p256dh: string;
        auth: string;
        vapidKeyId: string;
      },
      generation: number,
    ) => {
      if (generation !== lifecycleGeneration.current || isPushEnableInFlight()) {
        return;
      }
      const confirmed = await reconcile({ subscription });
      if (generation !== lifecycleGeneration.current) {
        return;
      }
      if (confirmed?.bound) {
        rememberPushEndpoint(subscription.endpoint);
        notifyPushSubscriptionChanged();
        return;
      }
      if (generation !== lifecycleGeneration.current || isPushEnableInFlight()) {
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
    for (let i = 0; i < unique.length; i += 1) {
      const endpoint = unique[i];
      if (!endpoint) {
        continue;
      }
      if (isPushEnableInFlight()) {
        // Keep remaining snapshot endpoints for a later retry — includes the
        // active endpoint when enable rebinds it mid-flush.
        failures.push(endpoint, ...unique.slice(i + 1).filter((value) => value.length > 0));
        break;
      }
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

  /** Retry failed unbinds even while an active subscription stays healthy. */
  const flushPendingCleanup = useEffectEvent(
    async (generation: number, exceptEndpoint?: string) => {
      if (generation !== lifecycleGeneration.current || isPushEnableInFlight()) {
        return;
      }
      const pending = recalledPendingPushCleanup().filter(
        (endpoint) => endpoint !== exceptEndpoint,
      );
      if (pending.length === 0) {
        return;
      }
      const failures = await disableCapturedEndpoints(pending);
      if (generation !== lifecycleGeneration.current) {
        return;
      }
      applyPendingCleanupFlushResult(pending, failures);
    },
  );

  const runReconcile = useEffectEvent(async () => {
    if (!vapid) {
      return;
    }
    const generation = lifecycleGeneration.current;
    try {
      const result = await readPushSubscriptionMaterial(vapid);
      if (generation !== lifecycleGeneration.current) {
        return;
      }
      if (result.unboundEndpoint) {
        if (isPushEnableInFlight()) {
          return;
        }
        const attempted = [result.unboundEndpoint, ...(result.unboundEndpoints ?? [])];
        const failures = await disableCapturedEndpoints(attempted);
        if (generation !== lifecycleGeneration.current) {
          return;
        }
        // Only clear active if it was one of the unbound endpoints — do not wipe
        // a newer enable that rebound a different endpoint mid-flush.
        if (!isPushEnableInFlight()) {
          const active = recalledPushEndpoint();
          if (active && attempted.includes(active)) {
            rememberPushEndpoint(null);
          }
        }
        applyPendingCleanupFlushResult(attempted, failures);
        notifyPushSubscriptionChanged();
        return;
      }
      if (!result.subscription) {
        await flushPendingCleanup(generation);
        return;
      }
      if (result.previousEndpoint) {
        const outcome = await replace({
          previousEndpoint: result.previousEndpoint,
          ...result.subscription,
        });
        if (generation !== lifecycleGeneration.current) {
          return;
        }
        if (outcome?.bound) {
          rememberPushEndpoint(result.subscription.endpoint);
          notifyPushSubscriptionChanged();
          await flushPendingCleanup(generation, result.subscription.endpoint);
          return;
        }
        // Parallel run may have already migrated — reconfirm before orphan drop.
        await dropIfStillUnbound(result.subscription, generation);
        return;
      }
      const outcome = await reconcile({ subscription: result.subscription });
      if (generation !== lifecycleGeneration.current) {
        return;
      }
      if (!outcome?.bound) {
        // Orphan / other-User / LRU-evicted — reconfirm first in case enable just committed.
        await dropIfStillUnbound(result.subscription, generation);
        return;
      }
      rememberPushEndpoint(result.subscription.endpoint);
      await flushPendingCleanup(generation, result.subscription.endpoint);
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
    lifecycleGeneration.current += 1;
    return () => {
      lifecycleGeneration.current += 1;
    };
  }, []);

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
