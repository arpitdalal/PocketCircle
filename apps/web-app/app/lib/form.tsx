import type { AnyFormState } from "@tanstack/react-form";
import { createFormHook, createFormHookContexts, useStore } from "@tanstack/react-form";
import type { ReactNode } from "react";
import { Button } from "~/components/ui/button.js";
import { Field, FieldError, FieldLabel } from "~/components/ui/field.js";
import { Input } from "~/components/ui/input.js";
import { Textarea } from "~/components/ui/textarea.js";
import type { CreateFormSubmitIntent } from "~/lib/create-form-submit.js";
import { cn } from "~/lib/utils.js";

const { fieldContext, formContext, useFieldContext, useFormContext } = createFormHookContexts();

export { fieldContext, formContext, useFieldContext, useFormContext };

/** ADR 0020: `(isBlurred && isDirty) || submissionAttempts > 0` — single contract for string fields.
 * Disabled / unresolved destination fields suppress reveal so an automatic reset cannot leave
 * "required" invalid styling fighting the amber warning contract (issue #298). */
function useFieldReveal(opts?: { suppress?: boolean }) {
  const field = useFieldContext<string>();
  const form = useFormContext();
  const showAllErrors = useStore(form.store, (s: AnyFormState) => s.submissionAttempts > 0);
  const reveal =
    !opts?.suppress && ((field.state.meta.isBlurred && field.state.meta.isDirty) || showAllErrors);
  const invalid = reveal && field.state.meta.errors.length > 0;
  return { field, invalid, errors: field.state.meta.errors };
}

function TextField({
  id,
  label,
  placeholder,
  maxLength,
  autoComplete = "off",
  onUserChange,
  describedBy,
  externallyInvalid = false,
}: {
  id: string;
  label: string;
  placeholder?: string;
  maxLength?: number;
  autoComplete?: string;
  /** Runs when the User edits the value — e.g. clear a stale mutation error. */
  onUserChange?: () => void;
  /** Extra description id(s) — e.g. a form-level mutation error tied to this field. */
  describedBy?: string;
  /** Extra invalid signal from a form-level error associated with this field. */
  externallyInvalid?: boolean;
}) {
  const { field, invalid: fieldInvalid, errors } = useFieldReveal();
  const invalid = fieldInvalid || externallyInvalid;
  const fieldErrorId = `${id}-error`;
  const ariaDescribedBy =
    [fieldInvalid ? fieldErrorId : undefined, describedBy].filter(Boolean).join(" ") || undefined;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={field.state.value}
        onChange={(event) => {
          onUserChange?.();
          field.handleChange(event.target.value);
        }}
        onBlur={field.handleBlur}
        maxLength={maxLength}
        placeholder={placeholder}
        autoComplete={autoComplete}
        aria-invalid={invalid}
        aria-describedby={ariaDescribedBy}
      />
      <FieldError id={fieldErrorId} errors={fieldInvalid ? errors : undefined} />
    </Field>
  );
}

function AmountField({
  id,
  label,
  onBlurNormalize,
  warning,
  disabled = false,
  onUserChange,
}: {
  id: string;
  label: string;
  /** Return `null` to skip `handleChange` on blur (keeps untouched empty from going dirty). */
  onBlurNormalize: (raw: string) => string | null;
  /**
   * Persistent automatic-reset warning text (issue #298): amber border + helper
   * text, deliberately NOT `aria-invalid` — the cleared value is usually valid.
   */
  warning?: string;
  disabled?: boolean;
  /** Runs when the User edits the value — a warning's clear trigger. */
  onUserChange?: () => void;
}) {
  const { field, invalid, errors } = useFieldReveal({ suppress: disabled });
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        inputMode="decimal"
        value={field.state.value}
        onChange={(event) => {
          onUserChange?.();
          field.handleChange(event.target.value);
        }}
        onBlur={() => {
          field.handleBlur();
          const normalized = onBlurNormalize(field.state.value);
          if (normalized !== null) {
            field.handleChange(normalized);
          }
        }}
        placeholder="0.00"
        autoComplete="off"
        aria-invalid={invalid}
        disabled={disabled}
        className={
          warning && !invalid
            ? "border-warning focus:border-warning focus:ring-warning/25"
            : undefined
        }
      />
      <FieldError errors={invalid ? errors : undefined} />
      {warning ? <p className="text-sm text-warning">{warning}</p> : null}
    </Field>
  );
}

function DateField({ id, label }: { id: string; label: string }) {
  const { field, invalid, errors } = useFieldReveal();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="date"
        value={field.state.value}
        onChange={(event) => field.handleChange(event.target.value)}
        onBlur={field.handleBlur}
        aria-invalid={invalid}
      />
      <FieldError errors={invalid ? errors : undefined} />
    </Field>
  );
}

function TextareaField({
  id,
  label,
  labelExtra,
  rows,
  maxLength,
  placeholder,
}: {
  id: string;
  label: string;
  labelExtra?: ReactNode;
  rows: number;
  maxLength: number;
  placeholder?: string;
}) {
  const { field, invalid, errors } = useFieldReveal();
  return (
    <Field>
      <FieldLabel htmlFor={id}>
        {label} {labelExtra}
      </FieldLabel>
      <Textarea
        id={id}
        value={field.state.value}
        onChange={(event) => field.handleChange(event.target.value)}
        onBlur={field.handleBlur}
        maxLength={maxLength}
        rows={rows}
        placeholder={placeholder}
        aria-invalid={invalid}
      />
      <FieldError errors={invalid ? errors : undefined} />
    </Field>
  );
}

/** Shared `<select>` field kit. Add field-level validators when a select gets schema-backed errors. */
function SelectField({
  id,
  label,
  options,
  showLoadingPlaceholder = false,
  displayValueFallback,
  warning,
  disabled = false,
  onUserChange,
}: {
  id: string;
  label: string;
  options: readonly { value: string; label: string }[];
  showLoadingPlaceholder?: boolean;
  /** When set, empty field value displays as this option's value (e.g. default member id). */
  displayValueFallback?: string;
  /** Persistent automatic-reset warning text (issue #298) — see {@link AmountField}. */
  warning?: string;
  disabled?: boolean;
  /** Runs when the User picks a value — a warning's clear trigger. */
  onUserChange?: () => void;
}) {
  const { field, invalid, errors } = useFieldReveal({ suppress: disabled });
  const shownValue =
    displayValueFallback !== undefined
      ? field.state.value || displayValueFallback
      : field.state.value;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select
        id={id}
        value={shownValue}
        onChange={(event) => {
          onUserChange?.();
          field.handleChange(event.target.value);
        }}
        onBlur={field.handleBlur}
        aria-invalid={invalid}
        disabled={disabled}
        className={cn(
          "w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30",
          warning && !invalid && "border-warning focus:border-warning focus:ring-warning/25",
        )}
      >
        {showLoadingPlaceholder ? <option value="">Loading…</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <FieldError errors={invalid ? errors : undefined} />
      {warning ? <p className="text-sm text-warning">{warning}</p> : null}
    </Field>
  );
}

function SubmitRow({
  isEdit,
  onCancel,
  disabled = false,
  onSaveAndNew,
  activeSubmitIntent = null,
}: {
  isEdit: boolean;
  /** What Cancel means to the host — navigation stays outside the form kit. */
  onCancel: () => void;
  /** Host-level block (e.g. Global Add with no resolved destination). */
  disabled?: boolean;
  /**
   * Create-only alternate submit (issue #287). Omit in edit. Enter / native
   * form submit never call this — only the visible Save & new control does.
   */
  onSaveAndNew?: () => void;
  /** Which create submit started the in-flight mutation; drives Saving… label. */
  activeSubmitIntent?: CreateFormSubmitIntent | null;
}) {
  const form = useFormContext();
  const isSubmitting = useStore(form.store, (s: AnyFormState) => s.isSubmitting);
  const actionsLocked = disabled || isSubmitting;
  return (
    <div className="flex scroll-mb-28 flex-wrap items-center gap-2 pt-2">
      <Button type="submit" disabled={actionsLocked} className="scroll-mb-28">
        {isSubmitting && activeSubmitIntent === "save"
          ? "Saving…"
          : isEdit
            ? "Save changes"
            : "Save"}
      </Button>
      {!isEdit && onSaveAndNew ? (
        <Button
          type="button"
          variant="outline"
          disabled={actionsLocked}
          onClick={onSaveAndNew}
          className="scroll-mb-28"
        >
          {isSubmitting && activeSubmitIntent === "save_and_new" ? "Saving…" : "Save & new"}
        </Button>
      ) : null}
      <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
        Cancel
      </Button>
    </div>
  );
}

const pocketCircleFieldComponents = {
  TextField,
  AmountField,
  DateField,
  TextareaField,
  SelectField,
};
const pocketCircleFormComponents = {
  SubmitRow,
};

const { useAppForm, useTypedAppFormContext } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: pocketCircleFieldComponents,
  formComponents: pocketCircleFormComponents,
});

export { useAppForm, useTypedAppFormContext };

export type PocketCircleFieldComponents = typeof pocketCircleFieldComponents;
export type PocketCircleFormComponents = typeof pocketCircleFormComponents;
