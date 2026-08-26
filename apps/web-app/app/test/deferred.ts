import { vi } from "vitest";

/**
 * A promise that stays pending until the test calls {@link DeferredValue.resolve}
 * or {@link DeferredValue.reject}. Shared seam for in-flight mutation doubles.
 */
export function deferredValue<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A `vi.fn` that returns one shared pending promise until resolved — for doubles
 * wired through `configureConvex` / `mockImplementation` rather than
 * `mockReturnValueOnce`.
 */
export function deferredMutationFn<T>() {
  const { promise, resolve } = deferredValue<T>();
  return { fn: vi.fn(() => promise), promise, resolve };
}
