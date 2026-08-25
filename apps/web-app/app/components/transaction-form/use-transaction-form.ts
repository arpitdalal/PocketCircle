import {
  defaultDateInMonth,
  minorUnitsToMajorString,
  type PlainMonth,
  parseAmountToMinorUnits,
  resolveCategories,
  type TransactionFormValues,
  type TransactionMutationArgs,
  type TransactionType,
  toMutationArgs,
} from "@pocketcircle/domain";
import { useStore } from "@tanstack/react-form";
import { useEffect, useMemo, useRef, useState } from "react";
import { track } from "~/lib/analytics.js";
import type {
  AnalyticsTransactionMethod,
  AnalyticsTransactionSurface,
} from "~/lib/analytics-events.js";
import {
  type Category,
  type Circle,
  type Member,
  type Transaction,
  useCategories,
  useCreateTransaction,
  useMembers,
  useUpdateTransaction,
} from "~/lib/data.js";
import { useAppForm } from "~/lib/form.js";
import { mutationErrorMessageForUser } from "~/lib/mutation-user-message.js";
import { resolvePaidBy } from "./resolve-paid-by.js";
import { emptyTransactionFormValues, transactionFormOptions } from "./transaction-form-options.js";
import type { TransactionResetField, TransactionResetReason } from "./transaction-form-resets.js";

const STALE_PAID_BY_ERROR =
  "The selected payer is no longer a member of this circle. Pick a current member.";

/**
 * The coarse, aggregate-safe context of the host page, emitted with
 * `transaction_added` on a successful create. Adapters own these values; they
 * must never carry Circle ids, Transaction ids, or any financial content.
 */
export interface TransactionFormAnalyticsContext {
  surface: AnalyticsTransactionSurface;
  method: AnalyticsTransactionMethod;
}

/**
 * What a finished submission hands back to the hosting route (issue #297). A
 * create exposes the new Transaction's id plus the exact validated values sent
 * to the server (`TransactionMutationArgs`) — everything a route needs to build
 * its canonical destination — while an update exposes the edited id. The
 * controller NEVER navigates; turning this result into a URL is the adapter's job.
 */
export type TransactionFormResult =
  | {
      kind: "created";
      transactionId: Transaction["id"];
      submitted: TransactionMutationArgs<Category["id"], Member["id"]>;
    }
  | { kind: "updated"; transactionId: Transaction["id"] };

/** Persistent amber warnings keyed by the field they mark (issue #298). */
export type TransactionResetWarnings = Partial<
  Record<TransactionResetField, TransactionResetReason>
>;

/**
 * Adapter input, fixed at mount. Both variants carry the completion callback
 * and the initial values; the create variant adds the URL-chosen Type, the
 * month that seeds the date default, and the analytics context (a create is the
 * only submission that emits an event). This is the entire contract between a
 * route and the shared form — the route derives it from its URL state and
 * passes it once.
 *
 * The CREATE variant's `circle` is the CURRENT destination, not a fixed one:
 * Global Add switches Circles in place without remounting the form (issue
 * #298), so the adapter passes `null` while no valid Circle is selected and a
 * different Circle after each confirmed switch. The edit variant keeps its
 * fixed Circle.
 */
export type UseTransactionFormInputs =
  | ({
      kind: "create";
      type: TransactionType;
      selectedMonth: PlainMonth;
      analytics: TransactionFormAnalyticsContext;
    } & TransactionFormCallbacks)
  | ({ kind: "edit"; transaction: Transaction } & EditTransactionFormCallbacks);

interface TransactionFormCallbacks {
  /**
   * Called exactly once per successful create or update, with the completion result.
   */
  onComplete: (result: TransactionFormResult) => void;
  /** The current create destination; `null` while Global Add has none selected. */
  circle: Circle | null;
  /**
   * Create-only escape hatch for submission failures: return `true` after
   * applying a route-owned contract (e.g. Global Add's submit-time destination
   * invalidation) to suppress the inline submit error. Anything else falls
   * through to the shared inline error while preserving the draft.
   */
  onSubmitFailure?: (error: unknown) => boolean;
}

interface EditTransactionFormCallbacks extends TransactionFormCallbacks {
  circle: Circle;
}

/**
 * The single Transaction-form controller (issue #297): ONE hook that owns the
 * TanStack form instance (ADR 0020), the Category and Member reads, inline
 * Category creation bookkeeping, the edit Type-Change application, domain
 * validation, both mutations, submission state, product analytics, and the
 * completion result. It is headless on purpose — routes pair it with the shared
 * `TransactionFormBody` and keep for themselves only what a URL owner must
 * decide: initialization timing, confirmation decisions, and navigation. Because
 * nothing here reads the router or owns a field tree of its own, any future
 * route can reuse it by supplying different inputs.
 *
 * The controller initializes ONCE from the given inputs: callers remount it
 * (React `key`) when their inputs change rather than expecting in-place resets —
 * a changed edit target is a new form, with fresh defaults and no stale draft.
 * Type Changes WITHIN a mounted form stay inside the controller via
 * {@link applyTypeChange}.
 *
 * Global Add (issue #298) is the one caller that must NOT remount on input
 * changes — its URL owns Type and Circle, and URL changes have to preserve the
 * portable draft in place. For it, the create variant's `circle` prop is
 * reactive (`null` while no valid Circle is selected) and the adapter drives
 * the transition contract through the imperative scoped-value APIs below:
 * {@link clearScopedValues} / {@link clearAmount} apply what a confirmed
 * switch, an automatic invalidation, or a Currency change clears, and the
 * reset-warning registry marks those fields until the User edits them again.
 * Switch resolution itself is a synchronous lookup against the reactive
 * `listMyCircles` result owned by the route, so an unresolvable switch fails
 * BEFORE anything is cleared and no snapshot/restore machinery exists.
 */
export function useTransactionForm(inputs: UseTransactionFormInputs) {
  const { circle, onComplete } = inputs;
  const createTransaction = useCreateTransaction();
  const updateTransaction = useUpdateTransaction();
  const isEdit = inputs.kind === "edit";
  const initialType = inputs.kind === "create" ? inputs.type : inputs.transaction.type;
  const [activeType, setActiveType] = useState<TransactionType>(initialType);
  const isTypeChanged = activeType !== initialType;
  // Submit handlers outlive the route when the User leaves mid-mutation (Back /
  // Cancel / other nav). Skip completion callbacks and post-unmount setState so
  // a late success cannot yank them to Detail from an unrelated page.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const categories = useCategories(circle?.id, activeType, { includeArchived: true });
  const members = useMembers(circle?.id);
  const allCategories = useMemo(() => categories ?? [], [categories]);
  const [inlineCreatedCategories, setInlineCreatedCategories] = useState<Category[]>([]);
  const pendingInlineCategories = useMemo(() => {
    const knownIds = new Set(allCategories.map((category) => category.id));
    return inlineCreatedCategories.filter((category) => !knownIds.has(category.id));
  }, [allCategories, inlineCreatedCategories]);

  const activeCategories = useMemo(() => {
    const fromQuery = allCategories.filter((category) => category.status === "active");
    const known = new Set(fromQuery.map((category) => category.id));
    const pending = pendingInlineCategories.filter(
      (category) => category.status === "active" && !known.has(category.id),
    );
    return pending.length === 0 ? fromQuery : [...fromQuery, ...pending];
  }, [allCategories, pendingInlineCategories]);
  const categoryById = useMemo(() => {
    const map = new Map<string, Category>(allCategories.map((category) => [category.id, category]));
    for (const category of pendingInlineCategories) {
      if (!map.has(category.id)) {
        map.set(category.id, category);
      }
    }
    return map;
  }, [allCategories, pendingInlineCategories]);

  const alreadyAttached = new Set<string>(
    inputs.kind === "edit" && !isTypeChanged
      ? inputs.transaction.categories.map((category) => category.id)
      : [],
  );

  const selfMemberId = (members ?? []).find((member) => member.isSelf)?.id ?? "";

  const paidByOptions = (members ?? []).map((member) => ({
    value: member.id,
    label: member.isSelf ? `${member.displayName} (You)` : member.displayName,
  }));
  if (inputs.kind === "edit") {
    const current = inputs.transaction.paidBy;
    if (!paidByOptions.some((option) => option.value === current.id)) {
      paidByOptions.push({ value: current.id, label: `${current.displayName} (removed)` });
    }
  }

  const [submitError, setSubmitError] = useState<string | null>(null);

  const defaultValues: TransactionFormValues =
    inputs.kind === "create"
      ? {
          ...emptyTransactionFormValues,
          type: inputs.type,
          date: defaultDateInMonth(inputs.selectedMonth, new Date()),
        }
      : {
          type: inputs.transaction.type,
          title: inputs.transaction.title,
          amount: minorUnitsToMajorString(inputs.transaction.amountMinorUnits),
          note: inputs.transaction.note ?? "",
          date: inputs.transaction.date,
          categoryIds: inputs.transaction.categories.map((category) => category.id),
          paidByMemberId: inputs.transaction.paidBy.id,
        };

  const form = useAppForm({
    ...transactionFormOptions(defaultValues),
    onSubmit: async ({ value }) => {
      setSubmitError(null);
      const categoryResolution = resolveCategories(
        value.categoryIds,
        categoryById,
        alreadyAttached,
      );
      if (!categoryResolution.ok) {
        return;
      }
      const categoryIds = categoryResolution.categoryIds;

      try {
        if (inputs.kind === "create") {
          if (!circle) {
            return;
          }
          const args = toMutationArgs(value, selfMemberId);
          const paidBy = resolvePaidBy(args.paidByMemberId ?? "", members ?? []);
          if (!paidBy.ok) {
            setSubmitError(STALE_PAID_BY_ERROR);
            return;
          }
          const submitted: TransactionMutationArgs<Category["id"], Member["id"]> = {
            type: args.type,
            title: args.title,
            note: args.note,
            amountMinorUnits: args.amountMinorUnits,
            date: args.date,
            categoryIds,
            ...(paidBy.memberId ? { paidByMemberId: paidBy.memberId } : {}),
          };
          const transactionId = await createTransaction({
            circleId: circle.id,
            ...submitted,
          });
          track("transaction_added", {
            type: args.type,
            paidBySelf: !value.paidByMemberId || paidBy.memberId === selfMemberId,
            categoryCount: categoryIds.length,
            surface: inputs.analytics.surface,
            method: inputs.analytics.method,
          });
          if (!mountedRef.current) {
            return;
          }
          onComplete({ kind: "created", transactionId, submitted });
        } else {
          const parsed = parseAmountToMinorUnits(value.amount);
          if (!parsed.ok) {
            throw new Error("amount failed to parse after validation");
          }
          const selected = value.paidByMemberId || selfMemberId;
          const paidBy = resolvePaidBy(selected, members ?? [], inputs.transaction.paidBy.id);
          if (!paidBy.ok) {
            setSubmitError(STALE_PAID_BY_ERROR);
            return;
          }
          await updateTransaction({
            transactionId: inputs.transaction.id,
            type: value.type,
            title: value.title,
            note: value.note.trim(),
            amountMinorUnits: parsed.minorUnits,
            date: value.date,
            categoryIds,
            ...(paidBy.memberId ? { paidByMemberId: paidBy.memberId } : {}),
          });
          if (!mountedRef.current) {
            return;
          }
          onComplete({ kind: "updated", transactionId: inputs.transaction.id });
        }
      } catch (error) {
        if (!mountedRef.current) {
          return;
        }
        if (inputs.kind === "create" && inputs.onSubmitFailure?.(error)) {
          return;
        }
        console.error("saveTransaction failed", error);
        setSubmitError(
          mutationErrorMessageForUser(error, "Couldn't save the transaction. Please try again."),
        );
      }
    },
  });

  /**
   * Applies an APPROVED Type Change (PRD 29, 30): flips the Category read to the
   * new Type, clears the selection, and drops inline-created Categories so they
   * remain in their original Type. Approval itself belongs to the host adapter —
   * it decides when a switch is confirmed and threads its decision here.
   */
  const applyTypeChange = (next: TransactionType) => {
    setActiveType(next);
    form.setFieldValue("type", next);
    form.setFieldValue("categoryIds", []);
    setInlineCreatedCategories([]);
  };

  /** Records a just-created Category so it stays selectable before the reactive read
   * catches up, deduplicated against what that read already returns. */
  const addInlineCreatedCategory = (category: Category) => {
    setInlineCreatedCategories((prev) =>
      prev.some((row) => row.id === category.id) ? prev : [...prev, category],
    );
  };

  // --- Global Add transition contract (issue #298). The adapter decides WHEN a
  // switch/reset happens; these imperative primitives apply its field effects
  // without remounting the form, so portable draft values survive. Warning
  // registry clears stay with the adapter (voluntary vs unexpected), not here.
  // Validation reveal on emptied fields is suppressed by the body while
  // `destinationReady` is false. Scoped clears use per-field `resetField` so
  // portable submissionAttempts / Title meta survive Circle switches.

  const [resetWarnings, setResetWarnings] = useState<TransactionResetWarnings>({});
  /** True while inline Category create is in flight — hosts must freeze destination
   * / Type transitions so a late completion cannot attach to the wrong draft. */
  const [destinationTransitionLocked, setDestinationTransitionLocked] = useState(false);
  const isSubmitting = useStore(form.store, (state) => state.isSubmitting);
  /** Freeze Circle/Type for any in-flight write that must finish against the
   * destination that started it (inline create OR transaction save). */
  const destinationControlsLocked = destinationTransitionLocked || isSubmitting;

  const clearScopedValues = () => {
    // Reset ONLY Circle-scoped fields (value + meta). Whole-form `reset` would
    // also wipe submissionAttempts / portable-field meta, so an invalid Title
    // that survived the switch would lose its required error until re-submit.
    // `resetField` leaves form submissionAttempts intact for Title/Note/Date.
    form.resetField("amount");
    form.resetField("categoryIds");
    form.resetField("paidByMemberId");
    setSubmitError(null);
    setInlineCreatedCategories([]);
  };

  const clearAmount = () => {
    // Same scoped-field reset: clear Amount value+meta without dropping the
    // form's submit-reveal (portable fields keep their post-submit errors;
    // Amount's fresh meta means an emptied value is not aria-invalid beside
    // the amber currency warning).
    form.resetField("amount");
    setSubmitError(null);
  };

  /** Marks fields with a reset reason after an UNEXPECTED automatic reset clears
   * their values; a voluntary confirmed switch never calls this. */
  const markResetWarnings = (
    fields: readonly TransactionResetField[],
    reason: TransactionResetReason,
  ) => {
    setResetWarnings((prev) => {
      const next = { ...prev };
      for (const field of fields) {
        next[field] = reason;
      }
      return next;
    });
  };

  /** Drops every automatic-reset warning — used by voluntary Circle switches. */
  const clearResetWarnings = () => {
    setResetWarnings({});
  };

  /** Clears one field's warning — invoked by the shared body when the User edits it. */
  const clearResetWarning = (field: TransactionResetField) => {
    setResetWarnings((prev) => {
      if (prev[field] === undefined) {
        return prev;
      }
      const { [field]: _cleared, ...rest } = prev;
      return rest;
    });
  };

  return {
    circle,
    form,
    isEdit,
    activeType,
    applyTypeChange,
    submitError,
    selfMemberId,
    paidByOptions,
    showPaidByLoadingPlaceholder: !isEdit && circle != null && selfMemberId === "",
    categoryById,
    alreadyAttached,
    activeCategories,
    addInlineCreatedCategory,
    destinationReady: circle != null,
    destinationControlsLocked,
    setDestinationTransitionLocked,
    clearScopedValues,
    clearAmount,
    resetWarnings,
    markResetWarnings,
    clearResetWarnings,
    clearResetWarning,
  };
}

export type TransactionFormController = ReturnType<typeof useTransactionForm>;
