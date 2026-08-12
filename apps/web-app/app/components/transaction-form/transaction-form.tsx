import {
  defaultDateInMonth,
  LIMITS,
  minorUnitsToMajorString,
  type PlainMonth,
  parseAmountToMinorUnits,
  resolveCategories,
  type TransactionFormValues,
  type TransactionType,
  toMutationArgs,
  transactionFieldSchemas,
} from "@pocketcircle/domain";
import { useMemo, useRef, useState } from "react";
import { FieldError, FieldGroup } from "~/components/ui/field.js";
import { track } from "~/lib/analytics.js";
import {
  type Category,
  type Circle,
  type Transaction,
  useCategories,
  useCreateTransaction,
  useMembers,
  useUpdateTransaction,
} from "~/lib/data.js";
import { useAppForm } from "~/lib/form.js";
import { mutationErrorMessageForUser } from "~/lib/mutation-user-message.js";
import { resolvePaidBy } from "./resolve-paid-by.js";
import { TransactionFormCategorySection } from "./transaction-form-category-section.js";
import { TYPE_LABEL } from "./transaction-form-constants.js";
import { emptyTransactionFormValues, transactionFormOptions } from "./transaction-form-options.js";
import { TransactionFormTypeEditSection } from "./transaction-form-type-section.js";

const STALE_PAID_BY_ERROR =
  "The selected payer is no longer a member of this circle. Pick a current member.";

/**
 * The open form, scoped to a CTA-chosen type for a create or to one saved
 * Transaction for an edit (TXN-2). The discriminant drives the defaults, the type
 * control, and which mutation the submit calls. A create lives inline on the
 * Monthly Ledger (driven by the `new` query param — TXN-5); an edit is its own
 * object route (`/transactions/:transactionRef/edit`), but both render this one
 * form so the field rules, validation, and submit wiring never fork.
 *
 * `selectedMonth` is a CREATE-only input: a new row's date defaults into the month the
 * Ledger is showing. An edit has no use for it — its date comes from the saved
 * Transaction — so it lives on the create variant, not as a shared prop the edit route
 * would have to fabricate a month to satisfy.
 */
export type TransactionFormMode =
  | { kind: "create"; type: TransactionType; selectedMonth: PlainMonth }
  | { kind: "edit"; transaction: Transaction };

/**
 * The Add / Edit Transaction form, built on TanStack Form (ADR 0020) so it shares one
 * form model with the future native app. Amount is entered in major units and
 * converted to minor units at submit (ADR 0009); the date is a plain `YYYY-MM-DD`;
 * Categories are a multi-select of the active Categories of the current type; Paid By
 * defaults to the creator and can be set to any current Member.
 *
 * Create scopes the type to the CTA. Edit prefills from the saved Transaction and adds
 * a segmented Expense/Income switch: switching on a saved Transaction is a Type Change
 * (PRD 29, 30), so it asks for confirmation, then CLEARS the Category selection and
 * requires re-picking from the new type's active Categories before save — the server
 * enforces the same (≥1 active Category of the new type, old ones cleared) and owns
 * every invariant (ADR 0015); the UI is the courtesy on top.
 *
 * Validation mirrors the shared schemas: each field validates on blur, errors reveal
 * on-blur-then-live (once a field is both blurred and dirty, or once submit was
 * attempted), and the whole-form `transactionFormSchema` is the submit gate.
 *
 * `onClose` is what "done" means to the caller — the create path removes the `new`
 * query param (staying on the ledger), the edit route navigates back to where it was
 * opened from (the detail page or the ledger), the URL slice preserved (TXN-5). The form
 * never owns navigation.
 */
export function TransactionForm({
  circle,
  mode,
  onClose,
}: {
  circle: Circle;
  mode: TransactionFormMode;
  onClose: () => void;
}) {
  const createTransaction = useCreateTransaction();
  const updateTransaction = useUpdateTransaction();
  const isEdit = mode.kind === "edit";
  const initialType = mode.kind === "create" ? mode.type : mode.transaction.type;
  const [activeType, setActiveType] = useState<TransactionType>(initialType);
  const isTypeChanged = activeType !== initialType;

  const categories = useCategories(circle.id, activeType, { includeArchived: true });
  const members = useMembers(circle.id);
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
    mode.kind === "edit" && !isTypeChanged
      ? mode.transaction.categories.map((category) => category.id)
      : [],
  );

  const selfMemberId = (members ?? []).find((member) => member.isSelf)?.id ?? "";

  const paidByOptions = (members ?? []).map((member) => ({
    value: member.id,
    label: member.isSelf ? `${member.displayName} (You)` : member.displayName,
  }));
  if (mode.kind === "edit") {
    const current = mode.transaction.paidBy;
    if (!paidByOptions.some((option) => option.value === current.id)) {
      paidByOptions.push({ value: current.id, label: `${current.displayName} (removed)` });
    }
  }

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingType, setPendingType] = useState<TransactionType | null>(null);
  const confirmTypeRef = useRef<HTMLButtonElement>(null);

  const defaultValues: TransactionFormValues =
    mode.kind === "create"
      ? {
          ...emptyTransactionFormValues,
          type: initialType,
          date: defaultDateInMonth(mode.selectedMonth, new Date()),
        }
      : {
          type: mode.transaction.type,
          title: mode.transaction.title,
          amount: minorUnitsToMajorString(mode.transaction.amountMinorUnits),
          note: mode.transaction.note ?? "",
          date: mode.transaction.date,
          categoryIds: mode.transaction.categories.map((category) => category.id),
          paidByMemberId: mode.transaction.paidBy.id,
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
        if (mode.kind === "create") {
          const args = toMutationArgs(value, selfMemberId);
          const paidBy = resolvePaidBy(args.paidByMemberId ?? "", members ?? []);
          if (!paidBy.ok) {
            setSubmitError(STALE_PAID_BY_ERROR);
            return;
          }
          await createTransaction({
            circleId: circle.id,
            type: args.type,
            title: args.title,
            note: args.note,
            amountMinorUnits: args.amountMinorUnits,
            date: args.date,
            categoryIds,
            paidByMemberId: paidBy.memberId,
          });
          track("transaction_added", {
            type: args.type,
            paidBySelf: !value.paidByMemberId || paidBy.memberId === selfMemberId,
            categoryCount: categoryIds.length,
          });
        } else {
          const parsed = parseAmountToMinorUnits(value.amount);
          if (!parsed.ok) {
            throw new Error("amount failed to parse after validation");
          }
          const selected = value.paidByMemberId || selfMemberId;
          const paidBy = resolvePaidBy(selected, members ?? [], mode.transaction.paidBy.id);
          if (!paidBy.ok) {
            setSubmitError(STALE_PAID_BY_ERROR);
            return;
          }
          await updateTransaction({
            transactionId: mode.transaction.id,
            type: value.type,
            title: value.title,
            note: value.note.trim(),
            amountMinorUnits: parsed.minorUnits,
            date: value.date,
            categoryIds,
            ...(paidBy.memberId ? { paidByMemberId: paidBy.memberId } : {}),
          });
        }
        onClose();
      } catch (error) {
        console.error("saveTransaction failed", error);
        setSubmitError(
          mutationErrorMessageForUser(error, "Couldn't save the transaction. Please try again."),
        );
      }
    },
  });

  const requestType = (next: TransactionType) => {
    if (next === activeType) {
      return;
    }
    setPendingType(next);
    queueMicrotask(() => confirmTypeRef.current?.focus());
  };
  const confirmTypeChange = () => {
    if (!pendingType) {
      return;
    }
    setActiveType(pendingType);
    form.setFieldValue("type", pendingType);
    form.setFieldValue("categoryIds", []);
    setInlineCreatedCategories([]);
    setPendingType(null);
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
      aria-label={isEdit ? "Edit transaction" : `Add ${TYPE_LABEL[activeType].toLowerCase()}`}
      className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm"
    >
      <form.AppForm>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            {isEdit ? "Edit transaction" : `Add ${TYPE_LABEL[activeType].toLowerCase()}`}
          </h2>
        </div>

        {isEdit ? (
          <TransactionFormTypeEditSection
            activeType={activeType}
            pendingType={pendingType}
            confirmTypeRef={confirmTypeRef}
            requestType={requestType}
            confirmTypeChange={confirmTypeChange}
            onCancelPendingType={() => setPendingType(null)}
          />
        ) : null}

        <FieldGroup>
          <form.AppField name="title" validators={{ onBlur: transactionFieldSchemas.title }}>
            {(f) => (
              <f.TextField
                id="txn-title"
                label="Title"
                maxLength={LIMITS.transactionTitleMax}
                placeholder="e.g. Weekly shop"
              />
            )}
          </form.AppField>

          <div className="grid grid-cols-2 gap-3">
            <form.AppField name="amount" validators={{ onBlur: transactionFieldSchemas.amount }}>
              {(f) => (
                <f.AmountField
                  id="txn-amount"
                  label={`Amount (${circle.currency})`}
                  onBlurNormalize={(raw) => {
                    const parsed = parseAmountToMinorUnits(raw);
                    return parsed.ok ? minorUnitsToMajorString(parsed.minorUnits) : null;
                  }}
                />
              )}
            </form.AppField>

            <form.AppField name="date" validators={{ onBlur: transactionFieldSchemas.date }}>
              {(f) => <f.DateField id="txn-date" label="Date" />}
            </form.AppField>
          </div>

          <TransactionFormCategorySection
            key={activeType}
            circleId={circle.id}
            categoryById={categoryById}
            alreadyAttached={alreadyAttached}
            activeCategories={activeCategories}
            activeType={activeType}
            onInlineCreatedCategory={(category) => {
              setInlineCreatedCategories((prev) =>
                prev.some((row) => row.id === category.id) ? prev : [...prev, category],
              );
            }}
          />

          <form.AppField name="paidByMemberId">
            {(f) => (
              <f.SelectField
                id="txn-paid-by"
                label="Paid by"
                options={paidByOptions}
                showLoadingPlaceholder={!isEdit && selfMemberId === ""}
                displayValueFallback={selfMemberId}
              />
            )}
          </form.AppField>

          <form.AppField name="note" validators={{ onBlur: transactionFieldSchemas.note }}>
            {(f) => (
              <f.TextareaField
                id="txn-note"
                label="Note"
                labelExtra={<span className="text-muted-foreground">(optional)</span>}
                maxLength={LIMITS.transactionNoteMax}
                rows={2}
                placeholder="Extra context"
              />
            )}
          </form.AppField>
        </FieldGroup>

        {submitError ? <FieldError>{submitError}</FieldError> : null}

        <form.SubmitRow
          isEdit={isEdit}
          activeTypeLabel={TYPE_LABEL[activeType]}
          onClose={onClose}
        />
      </form.AppForm>
    </form>
  );
}
