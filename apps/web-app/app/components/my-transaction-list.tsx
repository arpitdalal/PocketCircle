import { formatMoney, money, toCurrencyCode } from "@pocketcircle/domain";
import { Link } from "react-router";
import { CircleMark } from "~/components/circle-mark.js";
import { RowsSkeleton, SkeletonRegion } from "~/components/skeleton.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import type { MyTransactionsResult } from "~/lib/data.js";
import { transactionDetailHref, transactionEditHref } from "~/lib/ledger-url.js";
import { viewerLocale } from "~/lib/locale.js";
import { MoneyAmountCell } from "~/lib/money-display.js";
import { useReturnToOrigin, withReturnTo } from "~/lib/return-to-url.js";
import { cn } from "~/lib/utils.js";

type MyTransactionRow = MyTransactionsResult["transactions"][number];

/**
 * Cross-Circle Paid-By list for My Transactions (#389). Each row carries its Circle
 * (name + currency); Edit when that Circle is active and the viewer may edit fields.
 */
export function MyTransactionList({
  results,
  emptyLabel,
}: {
  results: MyTransactionsResult;
  emptyLabel: string;
}) {
  const origin = useReturnToOrigin();

  if (results.isLoading) {
    return (
      <SkeletonRegion label="Loading transactions…" testId="my-transactions-skeleton">
        <RowsSkeleton rows={5} />
      </SkeletonRegion>
    );
  }
  if (results.transactions.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {results.transactions.map((txn) => (
        <MyTransactionRowItem key={txn.id} txn={txn} origin={origin} />
      ))}
    </ul>
  );
}

function MyTransactionRowItem({ txn, origin }: { txn: MyTransactionRow; origin: string }) {
  const circle = txn.circle;
  const canEdit = circle.status === "active" && txn.canEditFields;

  return (
    <li className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 shadow-sm">
      <CircleMark mark={circle.mark} color={circle.color} className="size-8 shrink-0 text-xs" />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate text-sm font-medium",
            txn.status === "archived" && "text-muted-foreground",
          )}
        >
          <Link
            to={withReturnTo(transactionDetailHref(circle, txn), origin)}
            className="hover:underline"
            aria-label={`View ${txn.title}`}
          >
            {txn.title}
          </Link>
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {txn.date} · {circle.name} · {circle.currency} ·{" "}
          {txn.categories.map((category) => category.name).join(", ")}
          {txn.status === "archived" ? (
            <span className="ml-1.5 inline-flex items-center rounded border border-border px-1.5 py-px text-xs font-medium">
              Archived
            </span>
          ) : null}
        </p>
      </div>
      <MoneyAmountCell
        className={cn(
          "text-sm font-semibold tabular-nums",
          txn.type === "income" ? "text-positive" : "text-foreground",
        )}
      >
        {`${txn.type === "income" ? "+" : "-"}${formatMoney(
          money(txn.amountMinorUnits, toCurrencyCode(circle.currency)),
          viewerLocale(),
        )}`}
      </MoneyAmountCell>
      {canEdit ? (
        <Link
          to={withReturnTo(transactionEditHref(circle, txn), origin)}
          aria-label={`Edit ${txn.title}`}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}
        >
          Edit
        </Link>
      ) : null}
    </li>
  );
}
