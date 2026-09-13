import { registerWorkpool } from "./registerWorkpool.js";

/** Registers the email workpool component for convex-test. */
export function registerEmailWorkpool(t: Parameters<typeof registerWorkpool>[0]) {
  registerWorkpool(t, "emailWorkpool");
}
