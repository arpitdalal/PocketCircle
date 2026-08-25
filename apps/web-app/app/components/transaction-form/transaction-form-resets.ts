/**
 * The shared automatic-reset contract (issue #298, decision #30): a route
 * controller supplies a reset REASON, and the shared Transaction form layers —
 * this module, the controller's warning registry, and the body's field
 * rendering — turn it into one consistent toast plus persistent field-local
 * warnings. Callers reuse these reasons instead of inventing copy.
 *
 * Warnings are deliberately NOT invalid-field semantics: the resulting value is
 * often valid (an empty Amount), so they render as amber border + helper text
 * and never set `aria-invalid`. Each warning clears when the User changes its
 * field; a voluntary confirmed reset produces no warnings at all.
 */

export type TransactionResetField = "amount" | "categoryIds" | "paidByMemberId";

export type TransactionResetReason =
  /** The selected Circle became inaccessible/archived/Setup-incomplete/unwritable. */
  | "circle_unavailable"
  /** The selected Circle's Currency changed while a draft Amount existed. */
  | "currency_changed";

/** The immediate generic toast for an unexpected automatic reset. */
export function transactionResetToast(reason: TransactionResetReason) {
  if (reason === "circle_unavailable") {
    return "That Circle is no longer available. Circle-specific fields were cleared.";
  }
  return "The Circle's currency changed. Amount was cleared.";
}

/** The fields an unexpected automatic reset touches, per reason. */
export function transactionResetFields(reason: TransactionResetReason) {
  if (reason === "circle_unavailable") {
    return [
      "amount",
      "categoryIds",
      "paidByMemberId",
    ] as const satisfies readonly TransactionResetField[];
  }
  return ["amount"] as const satisfies readonly TransactionResetField[];
}

/** The persistent amber helper text rendered under each affected field. */
export function transactionResetWarning(
  reason: TransactionResetReason,
  field: TransactionResetField,
) {
  if (reason === "circle_unavailable") {
    if (field === "amount") {
      return "Amount was cleared because the Circle is no longer available.";
    }
    if (field === "categoryIds") {
      return "Categories were cleared because the Circle is no longer available.";
    }
    return "Paid By was cleared because the Circle is no longer available.";
  }
  return "Amount was cleared because the Circle's currency changed.";
}
