import type { Doc } from "./_generated/dataModel.js";

/**
 * Setup milestone fields stay in lockstep: `setupCompletedAt` is the product
 * timestamp; `setupComplete` is the indexed boolean for bounded Activation CTA
 * lookups. Writers always set both. `setupComplete` stays optional in schema
 * until existing Circles are backfilled in prod.
 */
export function circleSetupFields(setupCompletedAt: number | null) {
  return {
    setupCompletedAt,
    setupComplete: setupCompletedAt !== null,
  };
}

/** Effective setup lane — prefers denormalized flag, else timestamp (pre-backfill). */
export function circleIsSetupComplete(
  circle: Pick<Doc<"circles">, "setupCompletedAt" | "setupComplete">,
) {
  if (circle.setupComplete !== undefined) {
    return circle.setupComplete;
  }
  return circle.setupCompletedAt !== null;
}
