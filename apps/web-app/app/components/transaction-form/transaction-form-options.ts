import { type TransactionFormValues, transactionFormSchema } from "@pocketcircle/domain";
import { formOptions } from "@tanstack/react-form";

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

/** Single source of truth for the Transaction form's options shape (values + validators). */
export function transactionFormOptions(defaultValues: TransactionFormValues) {
  return formOptions({
    defaultValues,
    validators: { onSubmit: transactionFormSchema },
  });
}

/** Module-scope options instance for `useTypedAppFormContext` (runtime-ignored, type-only). */
export const transactionFormContextOptions = transactionFormOptions(emptyTransactionFormValues);
