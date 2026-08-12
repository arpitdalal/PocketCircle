import type { TransactionType } from "@pocketcircle/domain";

export const TYPE_LABEL: Record<TransactionType, string> = {
  expense: "Expense",
  income: "Income",
};
