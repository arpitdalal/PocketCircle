import { vi } from "vitest";
import { deferredValue } from "~/lib/deferred.js";

export { deferredValue } from "~/lib/deferred.js";

/**
 * A `vi.fn` that returns one shared pending promise until resolved — for doubles
 * wired through `configureConvex` / `mockImplementation` rather than
 * `mockReturnValueOnce`.
 */
export function deferredMutationFn<T>() {
  const { promise, resolve } = deferredValue<T>();
  return { fn: vi.fn(() => promise), promise, resolve };
}
