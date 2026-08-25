import { TRANSACTION_TYPES, type TransactionType } from "@pocketcircle/domain";
import { useRef, useState } from "react";
import { Button } from "~/components/ui/button.js";
import { FieldLegend, FieldSet } from "~/components/ui/field.js";
import { cn } from "~/lib/utils.js";
import { TYPE_LABEL } from "./transaction-form-constants.js";

/**
 * The edit form's Type control and its Type-Change confirmation (PRD 29, 30).
 * Picking the other Type never applies immediately: the section first asks
 * (an inline `alertdialog` with focus moved to the confirm button), and only an
 * explicit confirm reports {@link onTypeChangeConfirmed} — Cancel discards the
 * request without touching the form. WHAT a confirmed change does lives with the
 * body's caller: `TransactionFormBody` defaults it to `controller.applyTypeChange`,
 * and a route adapter may override it with its own decision.
 */
export function TransactionFormTypeEditSection({
  activeType,
  onTypeChangeConfirmed,
  disabled = false,
}: {
  activeType: TransactionType;
  onTypeChangeConfirmed: (next: TransactionType) => void;
  /** Blocks starting a Type change (e.g. while inline Category create is in flight). */
  disabled?: boolean;
}) {
  const [pendingType, setPendingType] = useState<TransactionType | null>(null);
  const confirmTypeRef = useRef<HTMLButtonElement>(null);

  const requestType = (next: TransactionType) => {
    if (disabled || next === activeType) {
      return;
    }
    setPendingType(next);
    queueMicrotask(() => confirmTypeRef.current?.focus());
  };
  const confirmTypeChange = () => {
    if (disabled || !pendingType) {
      return;
    }
    onTypeChangeConfirmed(pendingType);
    setPendingType(null);
  };

  return (
    <FieldSet>
      <FieldLegend>Type</FieldLegend>
      <div className="flex gap-2">
        {TRANSACTION_TYPES.map((option) => {
          const pressed = activeType === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={pressed}
              disabled={disabled}
              onClick={() => requestType(option)}
              className={cn(
                "rounded-md border px-3 py-1 text-sm transition-colors",
                disabled && "opacity-50",
                pressed
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {TYPE_LABEL[option]}
            </button>
          );
        })}
      </div>
      {pendingType ? (
        <div
          // react-doctor-disable-next-line react-doctor/prefer-html-dialog -- inline confirmation banner, not a modal; no focus trap or backdrop needed.
          role="alertdialog"
          aria-labelledby="txn-type-confirm-title"
          aria-describedby="txn-type-confirm-desc"
          className="space-y-2 rounded-md border border-amber-600/70 bg-amber-950/30 p-3"
        >
          <p id="txn-type-confirm-title" className="text-sm font-semibold text-amber-200">
            Change to {TYPE_LABEL[pendingType].toLowerCase()}?
          </p>
          <p id="txn-type-confirm-desc" className="text-sm text-amber-300/90">
            This clears the selected categories. You{"'"}ll re-pick from{" "}
            {TYPE_LABEL[pendingType].toLowerCase()} categories before saving.
          </p>
          <div className="flex gap-2">
            <Button
              ref={confirmTypeRef}
              type="button"
              disabled={disabled}
              onClick={confirmTypeChange}
            >
              Change type
            </Button>
            <Button type="button" variant="outline" onClick={() => setPendingType(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </FieldSet>
  );
}
