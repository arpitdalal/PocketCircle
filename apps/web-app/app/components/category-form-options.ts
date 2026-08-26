import { type CategoryFormValues, categoryInputSchema } from "@pocketcircle/domain";
import { formOptions } from "@tanstack/react-form";

/**
 * Single source of truth for standalone Category creation's TanStack Form options
 * (values + Standard Schema submit gate). Callers supply mount-time defaults —
 * including the one-shot random Color — so renders never re-roll Color.
 */
export function categoryFormOptions(defaultValues: CategoryFormValues) {
  return formOptions({
    defaultValues,
    validators: { onSubmit: categoryInputSchema },
  });
}
