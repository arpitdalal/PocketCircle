import { formatMoney, money, toCurrencyCode } from "@pocketcircle/domain";
import { Link, useSearchParams } from "react-router";
import { HistoryList } from "~/components/history-list.js";
import { Splash } from "~/components/splash.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import { circlePath } from "~/lib/circle-path.js";
import { type Circle, type TransactionDetail, useTransactionHistory } from "~/lib/data.js";
import { formatAuditTimestamp } from "~/lib/datetime.js";
import { isEligibleDestination } from "~/lib/global-add-transitions.js";
import { globalAddHref } from "~/lib/global-add-url.js";
import { transactionDetailHref, transactionEditHref } from "~/lib/ledger-url.js";
import { viewerLocale } from "~/lib/locale.js";
import { parseReturnTo, RETURN_TO_PARAM, withReturnTo } from "~/lib/return-to-url.js";
import { useResolvedTransactionDetail } from "~/lib/use-resolved-transaction-detail.js";
import { useCircle } from "~/routes/layouts/circle-layout.js";

/**
 * The Transaction DETAIL object route — `/circles/:circleRef/transactions/:transactionRef`
 * (TXN-4, ADR 0016/0017) and the REFERENCE object route the object-guard pattern is built
 * around. {@link useResolvedTransactionDetail} fetches the target BY ID (so a Transaction
 * outside the visible ledger page still opens), canonicalizes a stale title slug in place,
 * and routes every missing / inaccessible / wrong-Circle case through the shared
 * unavailable-link fallback to the Circle's Transactions route.
 *
 * A read surface: it shows the Transaction's fields, its **Audit Metadata** (created/
 * updated by + at — PRD story 76), and its **Transaction History** (the shared
 * {@link HistoryList}, paginated — PRD story 77). It works for an archived (frozen)
 * Transaction too. Creating / editing / archiving live in their own slices (TXN-1/2/3);
 * this only LINKS to the edit object route as a courtesy, gated on the server's
 * `canEditFields` flag and a writable Circle — the server re-checks every mutation (ADR
 * 0015), so the link is never the enforcement. Duplicate (issue #299) is a secondary
 * outline action that opens Global Add with initialization-only source refs — not gated
 * on edit permission or destination writability. No raw internal IDs are shown (PRD 80).
 */
export default function TransactionDetailRoute() {
  const circle = useCircle();
  const [searchParams] = useSearchParams();

  // The validated `returnTo` origin (issue #123) is both the Back target and the bad-link
  // fallback for the resolver, so an unavailable detail link returns the User to where they
  // opened it FROM. Absent / malformed / out-of-scope falls back to the Circle's ledger.
  const returnTo = parseReturnTo(searchParams.get(RETURN_TO_PARAM), {
    fallback: circlePath(circle.ref, "transactions"),
  });
  const resolution = useResolvedTransactionDetail({ fallback: returnTo });

  if (resolution.status === "pending") {
    return <Splash label="Opening transaction…" />;
  }

  return <TransactionDetailView circle={circle} transaction={resolution.value} backTo={returnTo} />;
}

function TransactionDetailView({
  circle,
  transaction,
  backTo,
}: {
  circle: Circle;
  transaction: TransactionDetail;
  backTo: string;
}) {
  const currency = toCurrencyCode(circle.currency);
  const amount = formatMoney(money(transaction.amountMinorUnits, currency), viewerLocale());
  const writable = circle.status === "active";
  const isArchived = transaction.status === "archived";

  // Canonical Detail URL rebuilt from the already-validated `backTo` — never echo a
  // tampered nested return value (issue #123 / #299).
  const detailReturn = withReturnTo(transactionDetailHref(circle, transaction), backTo);

  // The Edit link carries THIS detail page's URL as its `returnTo`, so the editor returns
  // here on close — and that nested `returnTo` is the canonical detail path re-built from the
  // already-validated `backTo`, NOT the raw `location.search` (which could echo a tampered
  // nested value). So both reads agree on the same validated origin, and a ledger → detail →
  // edit → close trip ends back on detail with Back still pointing at the ledger (issue #123).
  const editUrl = withReturnTo(transactionEditHref(circle, transaction), detailReturn);

  // Duplicate opens ordinary Global Add with initialization-only source refs. Destination
  // Circle is set only when this Circle is an eligible Global Add destination; Archived
  // Circles remain readable sources without granting destination writability.
  const duplicateUrl = globalAddHref({
    type: transaction.type,
    circleRef: isEligibleDestination(circle) ? circle.ref : undefined,
    sourceCircleRef: circle.ref,
    sourceTransactionRef: transaction.ref,
    returnTo: detailReturn,
  });

  const showEdit = writable && transaction.canEditFields && !isArchived;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Link to={backTo} className="text-sm text-muted-foreground hover:text-foreground">
          ‹ Back
        </Link>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link
            to={duplicateUrl}
            aria-label={`Duplicate ${transaction.title}`}
            className={buttonVariants({ variant: "ghost", size: "default" })}
          >
            Duplicate
          </Link>
          {showEdit ? (
            <Link
              to={editUrl}
              aria-label={`Edit ${transaction.title}`}
              className={buttonVariants({ variant: "outline", size: "default" })}
            >
              Edit
            </Link>
          ) : null}
        </div>
      </div>

      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-xl font-semibold tracking-tight">{transaction.title}</h2>
          {isArchived ? (
            <span className="rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
              Archived
            </span>
          ) : null}
        </div>
        <p
          className={
            transaction.type === "income"
              ? "font-display text-3xl font-semibold tabular-nums text-positive"
              : "font-display text-3xl font-semibold tabular-nums text-foreground"
          }
        >
          {transaction.type === "income" ? "+" : "-"}
          {amount}
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <Field label="Type">{transaction.type === "income" ? "Income" : "Expense"}</Field>
        <Field label="Date">{transaction.date}</Field>
        <Field label="Paid By">{transaction.paidBy.displayName}</Field>
        <Field label="Recorded By">{transaction.recordedBy.displayName}</Field>
        <Field label="Categories">
          {transaction.categories.map((category) => category.name).join(", ")}
        </Field>
        {transaction.note ? <Field label="Note">{transaction.note}</Field> : null}
      </dl>

      <AuditMetadata audit={transaction.audit} />

      <TransactionHistory circleId={circle.id} transactionId={transaction.id} />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-foreground">{children}</dd>
    </div>
  );
}

/**
 * The Audit Metadata block (PRD story 76): who created the Transaction and when, and who
 * last changed it and when. Timestamps render in a fixed reference zone, never the
 * viewer's timezone (Audit Metadata glossary — see {@link formatAuditTimestamp}).
 */
function AuditMetadata({ audit }: { audit: TransactionDetail["audit"] }) {
  const rows = [
    { label: "Created", member: audit.createdBy.displayName, at: audit.createdAt },
    { label: "Last updated", member: audit.updatedBy.displayName, at: audit.updatedAt },
  ];
  return (
    <section aria-label="Audit metadata" className="space-y-2">
      <h3 className="text-sm font-semibold">Details</h3>
      <dl className="grid gap-y-2 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex flex-wrap items-baseline gap-x-2">
            <dt className="text-muted-foreground">{row.label} by</dt>
            <dd className="text-foreground">{row.member}</dd>
            <dd className="text-muted-foreground">
              ·{" "}
              <time dateTime={new Date(row.at).toISOString()}>{formatAuditTimestamp(row.at)}</time>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The Transaction History list (PRD story 77) — the paginated audit fed into the shared
 * {@link HistoryList}. Kept a thin wrapper so the data hook stays out of the render shell. */
function TransactionHistory({
  circleId,
  transactionId,
}: {
  circleId: Circle["id"];
  transactionId: TransactionDetail["id"];
}) {
  const { events, status, loadMore } = useTransactionHistory(circleId, transactionId);
  return <HistoryList events={events} status={status} loadMore={loadMore} label="History" />;
}
