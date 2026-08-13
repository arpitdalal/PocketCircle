import type { TestConvex } from "convex-test";
import { vi } from "vitest";
import type schema from "../convex/schema.js";

type ConvexTestHandle = TestConvex<typeof schema>;

/**
 * batch-worker (workpool 0.4.9) polls every 200ms during a 2s cooldown, then
 * goes idle. `runAllTimers` also fires the 2min liveness monitor + 60s stats
 * loop, which either wedges `finishAllScheduledFunctions` or leaves the worker
 * `running` so the next `ping` is a no-op. Step only the poll interval.
 */
const WORKPOOL_POLL_MS = 200;

async function finishScheduled(t: ConvexTestHandle) {
  await t.finishAllScheduledFunctions(() => {
    vi.advanceTimersByTime(WORKPOOL_POLL_MS);
  });
}

async function withFakeTimers<T>(run: () => Promise<T>) {
  const alreadyFake = vi.isFakeTimers();
  if (!alreadyFake) {
    vi.useFakeTimers();
  }
  try {
    return await run();
  } finally {
    if (!alreadyFake) {
      vi.useRealTimers();
    }
  }
}

/** Runs a mutation (or other async work) then drains scheduler-backed jobs (ADR 0027). */
export async function mutateAndDrain<T>(t: ConvexTestHandle, run: () => Promise<T>) {
  return withFakeTimers(async () => {
    const result = await run();
    await finishScheduled(t);
    return result;
  });
}

/** Drains pending scheduler jobs without wrapping a mutation. */
export async function drainScheduledFunctions(t: ConvexTestHandle) {
  await withFakeTimers(() => finishScheduled(t));
}

type WorkpoolRetry = {
  maxAttempts: number;
  initialBackoffMs: number;
  base: number;
};

/**
 * Like `mutateAndDrain`, then advances through Workpool retry backoffs until
 * the job is terminal (`onComplete` / final failure).
 *
 * `finishAllScheduledFunctions` returns once nothing is currently due, so a
 * retry sitting in `pendingStart` (idle timeout + jitter) is left behind.
 * Workpool jitter is `delay * (0.5 + random)` — advance 1.5x then drain again.
 * Fake timers must wrap the enqueue: timeouts registered on the real clock
 * cannot be fired by `advanceTimersByTime`.
 */
export async function mutateAndDrainRetries<T>(
  t: ConvexTestHandle,
  run: () => Promise<T>,
  retry: WorkpoolRetry,
) {
  return withFakeTimers(async () => {
    const result = await run();
    await finishScheduled(t);
    for (let attempt = 1; attempt < retry.maxAttempts; attempt++) {
      const backoffMs = retry.initialBackoffMs * retry.base ** (attempt - 1);
      vi.advanceTimersByTime(Math.ceil(backoffMs * 1.5) + WORKPOOL_POLL_MS);
      await finishScheduled(t);
    }
    return result;
  });
}
