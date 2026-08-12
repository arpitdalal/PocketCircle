import { TRANSACTION_TYPES, type TransactionType } from "@pocketcircle/domain";
import type { RefObject } from "react";
import { Button } from "~/components/ui/button.js";
import { FieldLegend, FieldSet } from "~/components/ui/field.js";
import { cn } from "~/lib/utils.js";
import { TYPE_LABEL } from "./transaction-form-constants.js";

export function TransactionFormTypeEditSection({
  activeType,
  pendingType,
  confirmTypeRef,
  requestType,
  confirmTypeChange,
  onCancelPendingType,
}: {
  activeType: TransactionType;
  pendingType: TransactionType | null;
  confirmTypeRef: RefObject<HTMLButtonElement | null>;
  requestType: (next: TransactionType) => void;
  confirmTypeChange: () => void;
  onCancelPendingType: () => void;
}) {
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
              onClick={() => requestType(option)}
              className={cn(
                "rounded-md border px-3 py-1 text-sm transition-colors",
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
            <Button ref={confirmTypeRef} type="button" onClick={confirmTypeChange}>
              Change type
            </Button>
            <Button type="button" variant="outline" onClick={onCancelPendingType}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </FieldSet>
  );
}
