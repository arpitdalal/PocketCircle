import { formatMoney, money, type PlainMonth, toCurrencyCode } from "@pocketcircle/domain";
import { useState } from "react";
import { Link } from "react-router";
import { InfiniteScrollFooter } from "~/components/infinite-scroll-footer.js";
import { RowsSkeleton, SkeletonRegion } from "~/components/skeleton.js";
import { Button } from "~/components/ui/button.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import {
  type Circle,
  type PaginatedTransactions,
  type Transaction,
  useArchiveTransaction,
  useRestoreTransaction,
} from "~/lib/data.js";
import { transactionDetailHref, transactionEditHref } from "~/lib/ledger-url.js";
import { viewerLocale } from "~/lib/locale.js";
import { mutationErrorMessageForUser } from "~/lib/mutation-user-message.js";
import { useReturnToOrigin, withReturnTo } from "~/lib/return-to-url.js";
import { useSnackbar } from "~/lib/snackbar.js";
import { useDoubleCheck } from "~/lib/use-double-check.js";
import { cn } from "~/lib/utils.js";

export function TransactionList({
  paginated,
  circle,
  emptyLabel,
  canEdit,
  ledgerMonth,
  showLifecycle,
  paginationMode = "infinite",
}: {
  paginated: PaginatedTransactions;
  circle: Circle;
  emptyLabel: string;
  canEdit: boolean;
  ledgerMonth?: PlainMonth;
  /**
   * Whether rows offer lifecycle actions (Archive/Restore). The ledger sets this; Search
   * is a read-only discovery surface and acts through the detail page instead. The action
   * each row offers is derived from that row's own `status`, so a mixed `status=all` list
   * still shows Archive on active rows and Restore on archived rows (not a dead view).
   */
  showLifecycle?: boolean;
  /** Search uses numbered pages; ledger and filters keep infinite scroll. */
  paginationMode?: "infinite" | "none";
}) {
  const { transactions, status, loadMore } = paginated;
  // This list renders on both the ledger and Search; either way its current URL (filters,
  // page, month) is the origin a row's detail/edit link returns to via `returnTo` (#123).
  const origin = useReturnToOrigin();

  if (status === "LoadingFirstPage") {
    return (
      <SkeletonRegion label="Loading transactions…" testId="transactions-skeleton">
        <RowsSkeleton rows={5} />
      </SkeletonRegion>
    );
  }
  if (transactions.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {transactions.map((txn) => (
          <li
            key={txn.id}
            className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 shadow-sm"
          >
            <div className="min-w-0">
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
                {txn.date} · {txn.categories.map((category) => category.name).join(", ")} ·{" "}
                {txn.paidBy.displayName}
                {txn.status === "archived" ? (
                  <span className="ml-1.5 inline-flex items-center rounded border border-border px-1.5 py-px text-xs font-medium">
                    Archived
                  </span>
                ) : null}
              </p>
            </div>
            <span
              className={cn(
                "ml-auto text-sm font-semibold tabular-nums",
                txn.type === "income" ? "text-positive" : "text-foreground",
              )}
            >
              {txn.type === "income" ? "+" : "-"}
              {formatMoney(
                money(txn.amountMinorUnits, toCurrencyCode(circle.currency)),
                viewerLocale(),
              )}
            </span>
            {ledgerMonth && txn.status === "active" && canEdit && txn.canEditFields ? (
              <Link
                to={withReturnTo(transactionEditHref(circle, txn), origin)}
                aria-label={`Edit ${txn.title}`}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Edit
              </Link>
            ) : null}
            {showLifecycle && canEdit && txn.canArchive ? (
              <LifecycleButton
                transaction={txn}
                action={txn.status === "archived" ? "restore" : "archive"}
              />
            ) : null}
          </li>
        ))}
      </ul>

      {paginationMode === "infinite" ? (
        <InfiniteScrollFooter
          status={status}
          loadMore={loadMore}
          loadingCopy="Loading more transactions…"
          listAriaLabel="Transaction list"
          sentinelTestId="transactions-infinite-scroll-sentinel"
        />
      ) : null}
    </div>
  );
}

const LIFECYCLE_COPY = {
  archive: {
    idle: "Archive",
    confirm: "Confirm archive",
    busy: "Archiving…",
    error: "Couldn't archive the transaction.",
  },
  restore: { idle: "Restore", busy: "Restoring…", error: "Couldn't restore the transaction." },
};

function LifecycleButton({
  transaction,
  action,
}: {
  transaction: Transaction;
  action: "archive" | "restore";
}) {
  if (action === "restore") {
    return <RestoreLifecycleButton transaction={transaction} />;
  }
  return <ArchiveLifecycleButton transaction={transaction} />;
}

function ArchiveLifecycleButton({ transaction }: { transaction: Transaction }) {
  const archiveTransaction = useArchiveTransaction();
  const { show } = useSnackbar();
  const [pending, setPending] = useState(false);
  const copy = LIFECYCLE_COPY.archive;

  const runArchive = async () => {
    setPending(true);
    try {
      await archiveTransaction({ transactionId: transaction.id });
    } catch (error) {
      console.error("archiveTransaction failed", error);
      show(mutationErrorMessageForUser(error, `${copy.error} Please try again.`));
    } finally {
      setPending(false);
    }
  };

  const { armed, getButtonProps } = useDoubleCheck({
    onConfirm: runArchive,
    identity: transaction.id,
  });
  const idleAriaLabel = `${copy.idle} ${transaction.title}`;

  return (
    <Button
      type="button"
      variant={armed && !pending ? "destructive" : "outline"}
      size="sm"
      disabled={pending}
      aria-label={
        pending ? idleAriaLabel : armed ? `${copy.confirm} ${transaction.title}` : idleAriaLabel
      }
      {...getButtonProps()}
    >
      {pending ? copy.busy : armed ? copy.confirm : copy.idle}
    </Button>
  );
}

function RestoreLifecycleButton({ transaction }: { transaction: Transaction }) {
  const restoreTransaction = useRestoreTransaction();
  const { show } = useSnackbar();
  const [pending, setPending] = useState(false);
  const copy = LIFECYCLE_COPY.restore;

  const onClick = async () => {
    setPending(true);
    try {
      await restoreTransaction({ transactionId: transaction.id });
    } catch (error) {
      console.error("restoreTransaction failed", error);
      show(mutationErrorMessageForUser(error, `${copy.error} Please try again.`));
    } finally {
      // Always clear the in-flight flag. On success the row stays mounted in a mixed
      // `status=all` list and `action` flips with the new `status`, so leaving `pending`
      // set would strand the button on the opposite action's busy label (issue #82).
      setPending(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={onClick}
      aria-label={`${copy.idle} ${transaction.title}`}
    >
      {pending ? copy.busy : copy.idle}
    </Button>
  );
}
