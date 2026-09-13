import { registerWorkpool } from "./registerWorkpool.js";

/** Registers the push workpool component for convex-test. */
export function registerPushWorkpool(t: Parameters<typeof registerWorkpool>[0]) {
  registerWorkpool(t, "pushWorkpool");
}
