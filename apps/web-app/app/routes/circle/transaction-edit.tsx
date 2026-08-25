import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Splash } from "~/components/splash.js";
import { TransactionFormBody } from "~/components/transaction-form/transaction-form-body.js";
import { useTransactionForm } from "~/components/transaction-form/use-transaction-form.js";
import { circlePath } from "~/lib/circle-path.js";
import type { Circle, Transaction } from "~/lib/data.js";
import { parseReturnTo, RETURN_TO_PARAM } from "~/lib/return-to-url.js";
import { useResolvedTransaction } from "~/lib/use-resolved-transaction.js";
import { useCircle } from "~/routes/layouts/circle-layout.js";

/**
 * The Transaction edit object route — `/circles/:circleRef/transactions/:transactionRef/edit`
 * (TXN-5, ADR 0016/0017). An edit deep link means "open an editable active
 * Transaction": {@link useResolvedTransaction} fetches the target BY ID (never from
 * the visible ledger page, so an off-month or off-page Transaction still opens),
 * canonicalizes a stale title slug in place, and routes every missing / inaccessible
 * / wrong-Circle / archived / not-editable-by-viewer case through the shared
 * unavailable-link fallback to the Circle's Transactions route — the selected month
 * preserved.
 *
 * This route is a ROUTE ADAPTER (issue #297): it owns URL state (`returnTo`), target
 * resolution (initialization timing), the read-only-Circle guard, and navigation, then
 * hands the shared {@link useTransactionForm} controller + {@link TransactionFormBody}
 * the resolved Transaction as its edit intent. It defines no fields of its own; the
 * Type Change confirmation's apply decision routes through `controller.applyTypeChange`.
 *
 * Where close (cancel or successful save), the bad-link fallback, and the archived
 * redirect all land is the validated `returnTo` origin (issue #123): the exact URL the
 * editor was opened FROM (the detail page, a filtered ledger, a search result), or — when
 * `returnTo` is absent / malformed / out-of-scope — the Circle's ledger. The detail
 * page's Edit link sets `returnTo` to its own URL, so Detail → Edit → close lands back
 * on Detail; a ledger row's Edit link sets the filtered ledger URL. An archived Circle
 * stays accessible and read-only, so an edit link there does not eject through the
 * unavailable path — it lands back on that same `returnTo` (the write surface is
 * closed). Reload re-fetches the latest server values; unsaved draft fields are not
 * persisted.
 */
export default function TransactionEdit() {
  const circle = useCircle();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const writable = circle.status === "active";

  // Close (cancel / successful save), the bad-link fallback, and the archived redirect all
  // return to the validated `returnTo` origin — the exact URL this editor was opened FROM,
  // with all of its filter/page/month state intact (issue #123). An absent / malformed /
  // out-of-scope value falls back to the Circle's ledger (anti-enumeration, ADR 0016).
  const ledgerBase = circlePath(circle.ref, "transactions");
  const returnUrl = parseReturnTo(searchParams.get(RETURN_TO_PARAM), { fallback: ledgerBase });

  // Set the instant we begin leaving (cancel or successful save).
  const [closing, setClosing] = useState(false);
  const close = () => {
    setClosing(true);
    navigate(returnUrl);
  };

  // The route only resolves an edit target while it should actually show the form: a
  // writable Circle and not already leaving. BOTH off-states must stop the resolver, so
  // its unavailable / canonicalize effects can never fire and race the route's own
  // navigation (ADR 0017):
  //   - `!writable` (archived): the Circle is read-only, so ANY edit URL — even one
  //     whose target resolves to `null` — must land on the in-place read-only ledger
  //     via the redirect below, never the generic unavailable-link snackbar.
  //   - `closing`: a save that renamed the Transaction changes its canonical ref, so a
  //     live resolver would canonicalize the now-stale URL slug with a `replace` and
  //     drag us back onto the edit route; gating lets the close navigation win.
  const active = writable && !closing;
  const resolution = useResolvedTransaction({ enabled: active, fallback: returnUrl });

  // An archived Circle is accessible but read-only: drop the edit form state and land on
  // the return target (the detail read surface when opened from there, else the in-place
  // read-only ledger — ADR 0017). Replace so the dead edit URL leaves no Back entry. The
  // resolver is already disabled above, so this is the only exit.
  useEffect(() => {
    if (!writable) {
      navigate(returnUrl, { replace: true });
    }
  }, [writable, navigate, returnUrl]);

  // While inactive (archived redirect or closing, both in flight) or while the target
  // resolves, show the splash rather than flashing a form about to be torn down.
  if (!active || resolution.status === "pending") {
    return <Splash label="Opening transaction…" />;
  }

  return (
    <TransactionEditForm
      // Keyed by the resolved Transaction id so navigating edit→edit between two targets
      // that resolve without a loading gap (e.g. Back/Forward to a cached one) REMOUNTS
      // the form instead of reusing it with the previous Transaction's TanStack defaults
      // and type state — the shared controller initializes once per mount from its inputs.
      key={resolution.value.id}
      circle={circle}
      transaction={resolution.value}
      onClose={close}
    />
  );
}

/** The edit-side adapter wiring: shared controller + shared body, no field tree here.
 * The completion result (the updated Transaction id) needs no URL of its own — THIS
 * route's contract is its historical one — close to the validated `returnTo` origin. */
function TransactionEditForm({
  circle,
  transaction,
  onClose,
}: {
  circle: Circle;
  transaction: Transaction;
  onClose: () => void;
}) {
  const controller = useTransactionForm({
    kind: "edit",
    circle,
    transaction,
    onComplete: () => onClose(),
  });
  return <TransactionFormBody controller={controller} onCancel={onClose} />;
}
