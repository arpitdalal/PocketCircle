import {
  LIMITS,
  minorUnitsToMajorString,
  parseAmountToMinorUnits,
  type TransactionType,
  transactionFieldSchemas,
} from "@pocketcircle/domain";
import { FieldError, FieldGroup } from "~/components/ui/field.js";
import { TransactionFormCategorySection } from "./transaction-form-category-section.js";
import { TYPE_LABEL } from "./transaction-form-constants.js";
import { type TransactionResetField, transactionResetWarning } from "./transaction-form-resets.js";
import { TransactionFormTypeEditSection } from "./transaction-form-type-section.js";
import type { TransactionFormController } from "./use-transaction-form.js";

/**
 * The ONE shared Transaction field body (issue #297): every field of the form —
 * Title, Amount, Date, Categories with inline creation, Paid By, Note — plus
 * validation messages, submit state, and the accessible Type-Change confirmation.
 * It is a pure renderer of {@link TransactionFormController} state: no data reads,
 * no mutations, no analytics, and never any navigation.
 *
 * `onCancel` is what Cancel means to the hosting route adapter — the route's close
 * navigation. An approved Type Change applies through the controller's own
 * `applyTypeChange` unless the adapter overrides `onTypeChangeConfirmed` with a
 * different decision. Everything else about the fields is owned here, so no route
 * ever defines a second Transaction field tree.
 *
 * Automatic-reset feedback (issue #298) is rendered here from the controller's
 * warning registry: an amber border plus field-specific helper text per affected
 * field — never invalid-field semantics — and each warning clears through
 * `clearResetWarning` the moment the User edits that field. While Global Add's
 * destination is unresolved (`destinationReady === false`), the Circle-dependent
 * controls (Amount, Categories, Paid By) are disabled; portable fields stay
 * usable.
 */
export function TransactionFormBody({
  controller,
  onCancel,
  onTypeChangeConfirmed = controller.applyTypeChange,
}: {
  controller: TransactionFormController;
  /** Invoked when the user activates Cancel — never by a successful save. */
  onCancel: () => void;
  /** Invoked after the user CONFIRMS a Type Change on an edit form. */
  onTypeChangeConfirmed?: (next: TransactionType) => void;
}) {
  const {
    circle,
    form,
    isEdit,
    activeType,
    submitError,
    selfMemberId,
    paidByOptions,
    showPaidByLoadingPlaceholder,
    categoryById,
    alreadyAttached,
    activeCategories,
    addInlineCreatedCategory,
    destinationReady,
    resetWarnings,
    clearResetWarning,
  } = controller;

  const warningFor = (field: TransactionResetField) => {
    const reason = resetWarnings[field];
    return reason === undefined ? undefined : transactionResetWarning(reason, field);
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
            onTypeChangeConfirmed={onTypeChangeConfirmed}
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
                  label={`Amount${circle ? ` (${circle.currency})` : ""}`}
                  onBlurNormalize={(raw) => {
                    const parsed = parseAmountToMinorUnits(raw);
                    return parsed.ok ? minorUnitsToMajorString(parsed.minorUnits) : null;
                  }}
                  warning={warningFor("amount")}
                  disabled={!destinationReady}
                  onUserChange={() => clearResetWarning("amount")}
                />
              )}
            </form.AppField>

            <form.AppField name="date" validators={{ onBlur: transactionFieldSchemas.date }}>
              {(f) => <f.DateField id="txn-date" label="Date" />}
            </form.AppField>
          </div>

          <TransactionFormCategorySection
            key={activeType}
            circleId={circle?.id ?? null}
            categoryById={categoryById}
            alreadyAttached={alreadyAttached}
            activeCategories={activeCategories}
            activeType={activeType}
            onInlineCreatedCategory={addInlineCreatedCategory}
            warning={warningFor("categoryIds")}
            disabled={!destinationReady}
            onSelectionChanged={() => clearResetWarning("categoryIds")}
          />

          <form.AppField name="paidByMemberId">
            {(f) => (
              <f.SelectField
                id="txn-paid-by"
                label="Paid by"
                options={paidByOptions}
                showLoadingPlaceholder={showPaidByLoadingPlaceholder}
                displayValueFallback={selfMemberId}
                warning={warningFor("paidByMemberId")}
                disabled={!destinationReady}
                onUserChange={() => clearResetWarning("paidByMemberId")}
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
          onCancel={onCancel}
          disabled={!destinationReady}
        />
      </form.AppForm>
    </form>
  );
}
