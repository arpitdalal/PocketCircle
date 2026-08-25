import { vi } from "vitest";

/**
 * A promise that stays pending until the test calls {@link DeferredValue.resolve}.
 * Shared seam for in-flight mutation doubles (inline Category create, save, etc.)
 * so each suite does not redefine the same Promise + resolver scaffolding.
 */
export function deferredValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
