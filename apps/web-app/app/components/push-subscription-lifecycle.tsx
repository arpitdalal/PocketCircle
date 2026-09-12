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
  recalledPendingPushCleanup,
  recordOrphanLocalDrop,
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
  /** Bumped on unmount so in-flight reconcile cannot drop a later session's sub. */
  const lifecycleGeneration = useRef(0);

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
    // Enable may have committed during unsubscribe — do not wipe its remember.
    if (isPushEnableInFlight()) {
      return;
    }
    // Preserve as pending so a foreign owner's server row keeps a retry handle.
    recordOrphanLocalDrop(expectedEndpoint);
    notifyPushSubscriptionChanged();
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
      rememberPushEndpoints(failures);
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
        const failures = await disableCapturedEndpoints([
          result.unboundEndpoint,
          ...(result.unboundEndpoints ?? []),
        ]);
        if (generation !== lifecycleGeneration.current) {
          return;
        }
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
