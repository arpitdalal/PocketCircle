/**
 * Setup milestone fields stay in lockstep: `setupCompletedAt` is the product
 * timestamp; `setupComplete` is the indexed boolean for bounded Activation CTA
 * lookups (earliest active regular Circle by createdAt within a setup lane).
 */
export function circleSetupFields(setupCompletedAt: number | null) {
  return {
    setupCompletedAt,
    setupComplete: setupCompletedAt !== null,
  };
}
