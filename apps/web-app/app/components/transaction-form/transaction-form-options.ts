import { type TransactionFormValues, transactionFormSchema } from "@pocketcircle/domain";
import { formOptions } from "@tanstack/react-form";
import { defaultCreateSubmitMeta } from "~/lib/create-form-submit.js";

/** Create-mode base values; the form overrides `type` and `date` per mode. */
export const emptyTransactionFormValues: TransactionFormValues = {
  type: "expense",
  title: "",
  amount: "",
  note: "",
  date: "",
  categoryIds: [],
  paidByMemberId: "",
};

/** Single source of truth for the Transaction form's options shape (values + validators + submit meta). */
export function transactionFormOptions(defaultValues: TransactionFormValues) {
  return formOptions({
    defaultValues,
    validators: { onSubmit: transactionFormSchema },
    onSubmitMeta: defaultCreateSubmitMeta,
  });
}

/** Module-scope options instance for `useTypedAppFormContext` (runtime-ignored, type-only). */
export const transactionFormContextOptions = transactionFormOptions(emptyTransactionFormValues);
