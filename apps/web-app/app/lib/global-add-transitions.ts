import { MUTATION_ERRORS, mutationErrorDataSchema } from "@pocketcircle/domain";
import { ConvexError } from "convex/values";
import {
  type TransactionResetReason,
  transactionResetFields,
  transactionResetToast,
} from "~/components/transaction-form/transaction-form-resets.js";

/**
 * Pure Global Add transition and reset derivation (issue #298): the decision
 * rules behind Circle/Type switches, optimistic rollback, automatic
 * invalidation, and destination-error classification, with zero React, router,
 * or data-layer imports so they are unit-testable in isolation. The route
 * adapter executes what these functions decide; the shared controller and body
 * apply the field effects.
 */

/** The Circle-scoped draft values — the only work a Circle switch can discard. */
export interface ScopedDraftSnapshot {
  amount: string;
  categoryIds: string[];
  paidByMemberId: string;
}

/**
 * Whether any Circle-scoped value holds work. An empty `paidByMemberId` is NOT
 * explicit work: the shared form displays it as the current User and submits
 * them by default, so a switch that would clear only an implicit default is
 * immediate.
 */
export function hasScopedDraft(snapshot: ScopedDraftSnapshot) {
  return (
    snapshot.amount !== "" || snapshot.categoryIds.length > 0 || snapshot.paidByMemberId !== ""
  );
}

/** A Circle switch confirms only when scoped values hold work; empty switches are immediate. */
export function requiresCircleSwitchConfirmation(snapshot: ScopedDraftSnapshot) {
  return hasScopedDraft(snapshot);
}

/** A Type change confirms only when Categories are selected; otherwise it applies immediately. */
export function requiresTypeChangeConfirmation(snapshot: ScopedDraftSnapshot) {
  return snapshot.categoryIds.length > 0;
}

/** The toast shown when an optimistic Circle switch fails and its snapshot is restored. */
export const SWITCH_RESTORED_TOAST = "Couldn't switch Circles. Your previous values were restored.";

/**
 * Eligibility for a Global Add destination (issue #290): active, Setup-complete
 * Circles where the User remains a current Member. Membership is guaranteed by
 * `listMyCircles` (it lists only circles holding an active membership row), so
 * the client-side check covers the two lifecycle flags the view carries.
 */
export function isEligibleDestination(circle: { status: string; setupComplete: boolean }) {
  return circle.status === "active" && circle.setupComplete;
}

export type DestinationInvalidation = {
  reason: TransactionResetReason;
  toast: string;
  fields: ReturnType<typeof transactionResetFields>;
};

/** The full reset contract — reason, toast, and affected fields — for one invalidation. */
export function destinationInvalidation(reason: TransactionResetReason): DestinationInvalidation {
  return {
    reason,
    toast: transactionResetToast(reason),
    fields: transactionResetFields(reason),
  };
}

const DESTINATION_INVALID_CODES = new Set<string>([
  MUTATION_ERRORS.circleArchived.code,
  MUTATION_ERRORS.circleSetupIncomplete.code,
]);

/**
 * Classifies a failed create submission as submit-time destination invalidation
 * (same reset contract as reactive loss) versus an ordinary inline error. The
 * coded cases arrive as `ConvexError`s from the backend guards (`assertWritable`,
 * `assertSetupComplete`); a revoked membership mid-submit arrives as the plain
 * `"Circle not found"` throw of `requireCircleAccess` — the one uncoded signal
 * that means the destination is gone, matched exactly because it has a single
 * home in `guard.ts`.
 */
export function isDestinationInvalidationError(error: unknown) {
  if (error instanceof ConvexError) {
    const parsed = mutationErrorDataSchema.safeParse(error.data);
    return parsed.success && DESTINATION_INVALID_CODES.has(parsed.data.code);
  }
  return error instanceof Error && error.message === "Circle not found";
}
