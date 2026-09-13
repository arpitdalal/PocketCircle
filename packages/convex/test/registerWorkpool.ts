import { register } from "@convex-dev/workpool/test";

/**
 * Registers a named Workpool component for convex-test. Lives in
 * `packages/convex/test/` (outside the deployed functions dir) because
 * `@convex-dev/workpool/test` uses `import.meta`, which breaks `convex deploy`
 * if any non-`.test.ts` module under `convex/` transitively imports it.
 */
export function registerWorkpool(t: Parameters<typeof register>[0], name: string) {
  register(t, name);
}
