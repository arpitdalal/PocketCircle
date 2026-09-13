import { register } from "@convex-dev/workpool/test";

/**
 * Registers the push workpool component for convex-test. Lives in
 * `packages/convex/test/` (outside the deployed functions dir) because
 * `@convex-dev/workpool/test` uses `import.meta`, which breaks `convex deploy`
 * if any non-`.test.ts` module under `convex/` transitively imports it.
 */
export function registerPushWorkpool(t: Parameters<typeof register>[0]) {
  register(t, "pushWorkpool");
}
