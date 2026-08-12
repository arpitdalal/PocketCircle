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
