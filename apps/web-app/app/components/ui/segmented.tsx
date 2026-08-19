import { cn } from "~/lib/utils.js";

/**
 * A small labeled segmented control (a fieldset of `aria-pressed` buttons) for
 * the filter surfaces — Type and Status on the ledger Filters panel, Transaction
 * Search, the Categories page's Category Filter, and the Notification Center tray.
 */
export function Segmented<Value extends string>({
  label,
  value,
  options,
  onChange,
  compact,
}: {
  label: string;
  value: Value;
  options: { label: string; value: Value }[];
  onChange: (value: Value) => void;
  /** Tray/header: legend is sr-only, options stay on one row. */
  compact?: boolean;
}) {
  return (
    <fieldset className={compact ? undefined : "space-y-2"}>
      <legend className={compact ? "sr-only" : "text-xs text-muted-foreground"}>{label}</legend>
      <div className={cn("flex gap-2", compact ? "flex-nowrap" : "flex-wrap")}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-md border px-3 py-1 text-sm transition-colors",
              value === option.value
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
