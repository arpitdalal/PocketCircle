import {
  COLOR_PALETTE,
  categoryInputSchema,
  colorLabel,
  LIMITS,
  randomColorId,
  type TransactionType,
} from "@pocketcircle/domain";
import { useState } from "react";
import { categoryFormOptions } from "~/components/category-form-options.js";
import { Button } from "~/components/ui/button.js";
import { FieldError } from "~/components/ui/field.js";
import { Segmented } from "~/components/ui/segmented.js";
import { track } from "~/lib/analytics.js";
import { type Circle, useCreateCategory } from "~/lib/data.js";
import { useAppForm } from "~/lib/form.js";
import { mutationErrorMessageForUser } from "~/lib/mutation-user-message.js";
import { cn } from "~/lib/utils.js";

const TYPE_OPTIONS: ReadonlyArray<{ value: TransactionType; label: string }> = [
  { value: "expense", label: "Expense" },
  { value: "income", label: "Income" },
];

/** Stable id linking the Name field to a form-level mutation rejection (a11y). */
const CATEGORY_MUTATION_ERROR_ID = "category-error";

/**
 * The new-Category form (issue #96; revised #138; TanStack Form #305): name, an
 * Expense/Income type toggle, and a palette color picker. Lifted off the Categories
 * list onto its own dedicated route (`category-new.tsx`) so the list no longer stacks
 * a create form above its rows. The owning route guards writability (ADR 0015) and
 * supplies `onClose` — what "done" means here: a successful create or a Cancel
 * navigates back to the validated `returnTo` origin (issue #123).
 *
 * Field state, validation timing, and pending submission live in TanStack Form
 * (ADR 0020). `type` is seeded from `initialType` — the list CTA may deep-link a
 * concrete type when it's filtered to one, or arrive with none under the default All
 * view, in which case the route seeds `expense` (issue #138). Toggling only re-labels
 * and retargets the create; it never wipes the name/color the user has entered. The
 * server owns the unique-name invariant (per Circle+type, case-insensitive, incl.
 * archived); its rejection stays on the form as a mutation error, distinct from field
 * validation.
 */
export function NewCategoryForm({
  circleId,
  initialType,
  onClose,
}: {
  circleId: Circle["id"];
  initialType: TransactionType;
  onClose: () => void;
}) {
  const createCategory = useCreateCategory();
  // One-shot Color + URL-seeded Type: useAppForm only reads defaultValues on mount,
  // but generating Color in render would re-roll on every parent render before mount
  // settles — and tests assert Color stability across field-driven rerenders.
  const [defaultValues] = useState(() => ({
    type: initialType,
    name: "",
    color: randomColorId(),
  }));
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useAppForm({
    ...categoryFormOptions(defaultValues),
    onSubmit: async ({ value }) => {
      setSubmitError(null);
      // Re-parse so the mutation gets schema output (trimmed Name), not raw field
      // strings — the onSubmit Standard Schema gate already passed.
      const parsed = categoryInputSchema.parse(value);
      try {
        await createCategory({
          circleId,
          name: parsed.name,
          type: parsed.type,
          color: parsed.color,
        });
        track("category_created", { type: parsed.type, source: "standalone" });
        onClose();
      } catch (caught) {
        setSubmitError(
          mutationErrorMessageForUser(caught, "Couldn't create the category. Please try again."),
        );
      }
    },
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
      // Names the form as a landmark region for screen-reader / heading navigation —
      // this dedicated create page would otherwise expose only the input's field label
      // (the standalone route had no heading at all). Mirrors `TransactionForm`'s labeled
      // create region.
      aria-label="New category"
      className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm"
    >
      <form.AppForm>
        <h2 className="font-display text-lg font-semibold tracking-tight">New category</h2>

        <form.AppField name="type">
          {(field) => (
            <Segmented
              label="Type"
              value={field.state.value}
              options={[...TYPE_OPTIONS]}
              onChange={(next) => {
                if (next !== field.state.value) {
                  field.handleChange(next);
                  // A name rejected as a duplicate is per-type, so switching type may
                  // clear the conflict — drop the stale mutation error.
                  setSubmitError(null);
                }
              }}
            />
          )}
        </form.AppField>

        <form.Subscribe selector={(state) => state.values.type}>
          {(type) => (
            <form.AppField name="name" validators={{ onBlur: categoryInputSchema.shape.name }}>
              {(field) => (
                <field.TextField
                  id="category-name"
                  label={`New ${type} category`}
                  maxLength={LIMITS.categoryNameMax}
                  placeholder="e.g. Groceries"
                  onUserChange={() => setSubmitError(null)}
                  describedBy={submitError ? CATEGORY_MUTATION_ERROR_ID : undefined}
                  externallyInvalid={submitError != null}
                />
              )}
            </form.AppField>
          )}
        </form.Subscribe>

        <form.AppField name="color">
          {(field) => (
            <ColorPicker
              legend="Color"
              color={field.state.value}
              onChange={(color) => field.handleChange(color)}
            />
          )}
        </form.AppField>

        {submitError ? (
          <FieldError id={CATEGORY_MUTATION_ERROR_ID}>{submitError}</FieldError>
        ) : null}

        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(isSubmitting) => (
            <div className="flex gap-2">
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Adding…" : "Add category"}
              </Button>
              <Button type="button" variant="outline" onClick={onClose} disabled={isSubmitting}>
                Cancel
              </Button>
            </div>
          )}
        </form.Subscribe>
      </form.AppForm>
    </form>
  );
}

/** The shared palette picker: one definition for the create and edit forms. */
export function ColorPicker({
  legend,
  color,
  onChange,
}: {
  legend: string;
  color: string;
  onChange: (color: string) => void;
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {COLOR_PALETTE.map((paletteColor) => (
          <button
            key={paletteColor.id}
            type="button"
            aria-label={paletteColor.name}
            aria-pressed={color === paletteColor.id}
            onClick={() => onChange(paletteColor.id)}
            style={{ backgroundColor: paletteColor.hex }}
            className={cn(
              "size-7 rounded-full ring-offset-2 ring-offset-background transition",
              color === paletteColor.id ? "ring-2 ring-ring" : "ring-0",
            )}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{colorLabel(color)}</p>
    </fieldset>
  );
}
