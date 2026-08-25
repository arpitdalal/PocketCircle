/**
 * The shared automatic-reset / prefill-warning contract (issues #298/#299): a
 * route controller supplies a reset REASON, and the shared Transaction form
 * layers — this module, the controller's warning registry, and the body's field
 * rendering — turn it into one consistent toast (unexpected destination resets
 * only) plus persistent field-local warnings. Callers reuse these reasons
 * instead of inventing copy.
 *
 * Warnings are deliberately NOT invalid-field semantics: the resulting value is
 * often valid (an empty Amount, a substituted Paid By), so they render as amber
 * border + helper text and never set `aria-invalid`. Each warning clears when
 * the User changes its field; a voluntary confirmed reset produces no warnings
 * at all. Duplicate omitted-Categories / substituted-Paid-By warnings never
 * trigger the unavailable-source toast.
 */

export type DestinationResetReason = "circle_unavailable" | "currency_changed";

export type PrefillWarningReason = "categories_omitted" | "paid_by_substituted";

export type TransactionResetReason = DestinationResetReason | PrefillWarningReason;

export type TransactionResetField = "amount" | "categoryIds" | "paidByMemberId";

/** The immediate generic toast for an unexpected automatic destination reset. */
export function transactionResetToast(reason: DestinationResetReason) {
  if (reason === "circle_unavailable") {
    return "That Circle is no longer available. Circle-specific fields were cleared.";
  }
  return "The Circle's currency changed. Amount was cleared.";
}

/** The fields an unexpected automatic reset touches, per reason. */
export function transactionResetFields(reason: DestinationResetReason) {
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
  if (reason === "currency_changed") {
    return "Amount was cleared because the Circle's currency changed.";
  }
  if (reason === "categories_omitted") {
    return "Some Categories from the source are no longer selectable and were omitted.";
  }
  return "Paid By was set to you because the source payer is no longer a member.";
}

/** Copy shown in Global Add's no-destination area after an Archived-source Duplicate. */
export const ARCHIVED_SOURCE_NO_DESTINATION_EXPLANATION =
  "Choose an active Circle to continue. The source Circle is Archived, so Amount, Categories, and Paid By were not copied.";
