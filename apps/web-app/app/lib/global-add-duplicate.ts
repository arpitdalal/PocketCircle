import {
  minorUnitsToMajorString,
  type PlainDate,
  type TransactionFormValues,
  type TransactionType,
  toPlainDate,
} from "@pocketcircle/domain";
import type { TransactionResetReason } from "~/components/transaction-form/transaction-form-resets.js";

/**
 * Pure Duplicate prefill and warning derivation (issue #299 / #293): given a
 * resolved source Transaction, the destination context, and the URL-owned Type,
 * produce the one-time draft values and field-local amber warnings. No React,
 * router, or data-layer imports so the complete source×destination matrix is
 * unit-testable in isolation. The Global Add route applies the result exactly
 * once; later source edits never re-enter this module for the visit.
 */

/** Minimal source shape — matches `TransactionDetail` fields the prefill needs. */
export interface DuplicateSourceTransaction {
  type: TransactionType;
  title: string;
  note?: string;
  amountMinorUnits: number;
  categories: ReadonlyArray<{ id: string }>;
  paidBy: { id: string };
}

/** Selectable Category id for the chosen Type in the destination Circle. */
export interface DuplicateSelectableCategory {
  id: string;
  status: string;
}

/** Current Member id in the destination Circle (Paid By eligibility). */
export interface DuplicateCurrentMember {
  id: string;
}

export interface DuplicatePrefillInput {
  source: DuplicateSourceTransaction;
  /** True when the source Circle is Archived (readable source, never a destination). */
  sourceCircleArchived: boolean;
  /**
   * Eligible destination Circle id currently applied, or `null` when absent /
   * not eligible. Compared to `sourceCircleId` for same-Circle scoped copy.
   */
  destinationCircleId: string | null;
  sourceCircleId: string;
  /** URL-owned Type — wins over the source Type on reload / override. */
  type: TransactionType;
  /** Active Categories selectable for `type` in the destination; empty when none. */
  selectableCategories: ReadonlyArray<DuplicateSelectableCategory>;
  /** Current Members in the destination; empty when none / no destination. */
  currentMembers: ReadonlyArray<DuplicateCurrentMember>;
  /** Current User's Member id in the destination; empty when unknown. */
  selfMemberId: string;
  /** Clock for Transaction Date (defaults to today). */
  today?: Date;
}

export interface DuplicatePrefillResult {
  values: Pick<
    TransactionFormValues,
    "title" | "note" | "date" | "amount" | "categoryIds" | "paidByMemberId"
  >;
  /**
   * Field-local amber warnings for omitted Categories / substituted Paid By.
   * Never uses invalid-field semantics and never triggers the unavailable toast.
   */
  warnings: Partial<Record<"categoryIds" | "paidByMemberId", TransactionResetReason>>;
  /** True when the archived-source no-destination explanation should show. */
  archivedSourceWithoutDestination: boolean;
}

function todayDate(today: Date | undefined): PlainDate {
  return toPlainDate(today ?? new Date());
}

/**
 * Derives the one-time Duplicate draft. Portable fields (Title, Note, Date)
 * always copy; Circle-scoped fields copy only when destination matches the
 * source Circle and is present. Explicit Type differing from the source clears
 * Categories while retaining Amount and eligible Paid By — the ordinary
 * Type-change contract.
 */
export function deriveDuplicatePrefill(input: DuplicatePrefillInput): DuplicatePrefillResult {
  const date = todayDate(input.today);
  const portable = {
    title: input.source.title,
    note: input.source.note ?? "",
    date,
  };

  const archivedSourceWithoutDestination =
    input.sourceCircleArchived && input.destinationCircleId === null;

  // Archived source Circle OR missing/different destination: no scoped copy.
  const sameCircle =
    input.destinationCircleId !== null && input.destinationCircleId === input.sourceCircleId;

  if (!sameCircle || input.sourceCircleArchived) {
    return {
      values: {
        ...portable,
        amount: "",
        categoryIds: [],
        paidByMemberId: "",
      },
      warnings: {},
      archivedSourceWithoutDestination,
    };
  }

  const amount = minorUnitsToMajorString(input.source.amountMinorUnits);
  const typeMatchesSource = input.type === input.source.type;

  const selectableIds = new Set(
    input.selectableCategories
      .filter((category) => category.status === "active")
      .map((category) => category.id),
  );
  const copiedCategoryIds = typeMatchesSource
    ? input.source.categories.map((category) => category.id).filter((id) => selectableIds.has(id))
    : [];
  const omittedCategories =
    typeMatchesSource &&
    input.source.categories.some((category) => !selectableIds.has(category.id));

  const memberIds = new Set(input.currentMembers.map((member) => member.id));
  const sourcePaidByCurrent = memberIds.has(input.source.paidBy.id);
  // Prefer the source payer when still current; otherwise default to the current
  // User. Empty self id should not happen once prefill waits on Members — leave
  // empty so the form's implicit self display still resolves once Members settle.
  const paidByMemberId = sourcePaidByCurrent ? input.source.paidBy.id : input.selfMemberId;
  const substitutedPaidBy = !sourcePaidByCurrent && input.selfMemberId !== "";

  const warnings: DuplicatePrefillResult["warnings"] = {};
  if (omittedCategories) {
    warnings.categoryIds = "categories_omitted";
  }
  if (substitutedPaidBy) {
    warnings.paidByMemberId = "paid_by_substituted";
  }

  return {
    values: {
      ...portable,
      amount,
      categoryIds: copiedCategoryIds,
      paidByMemberId,
    },
    warnings,
    archivedSourceWithoutDestination: false,
  };
}
