import {
  currentMonth,
  isValidPlainMonth,
  type PlainMonth,
  type TransactionType,
} from "@pocketcircle/domain";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Splash } from "~/components/splash.js";
import {
  TransactionFormBody,
  type TransactionFormResult,
} from "~/components/transaction-form/index.js";
import { useTransactionForm } from "~/components/transaction-form/use-transaction-form.js";
import { circlePath } from "~/lib/circle-path.js";
import type { Circle } from "~/lib/data.js";
import { parseReturnTo, RETURN_TO_PARAM } from "~/lib/return-to-url.js";
import { useSnackbar } from "~/lib/snackbar.js";
import { useCircle } from "~/routes/layouts/circle-layout.js";

/**
 * The new-Transaction route — `/circles/:circleRef/transactions/new` (issue #96; Save & new
 * #287). A dedicated create page so the ledger no longer stacks a create form above its
 * rows, mirroring `transaction-edit.tsx`'s lifecycle (the up-to-date object-route template).
 *
 * This route is a ROUTE ADAPTER (issue #297): it owns URL state (`type`, `month`,
 * `returnTo`), the guards, initialization timing, and navigation, then hands the
 * shared {@link useTransactionForm} controller + {@link TransactionFormBody} its fixed
 * inputs. It defines no fields of its own.
 *
 * Own params (URL-view-state convention, ADR 0016):
 *   - `type=expense|income` (required) — the kind of Transaction to create. Missing /
 *     invalid is treated like an archived Circle: there is nothing safe to show, so the
 *     route ejects to the validated `returnTo` origin rather than guessing a type.
 *   - `month` — the create form's date default (`selectedMonth`), so opening the form
 *     from a navigated ledger month files the new row into THAT month. A missing /
 *     malformed month falls to the current month. This is the page's own create concern,
 *     distinct from `returnTo`.
 *
 * Close (cancel / ordinary Save), the invalid-`type` guard, and the archived-Circle
 * redirect ALL land on the validated `returnTo` (issue #123). Save & new stays on this
 * URL with Type/month/return origin intact; the route owns the success snackbar and
 * Title focus. `closing` + `Splash` keep the form from flashing while the close
 * navigation is in flight, exactly as edit does.
 */
export default function TransactionNew() {
  const circle = useCircle();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const writable = circle.status === "active";

  // The single safe return target (issue #123): the exact URL the CTA was opened FROM,
  // else the Circle's ledger. Covers close, the invalid-`type` guard, and the archived
  // redirect — a tampered / out-of-scope value is indistinguishable from an absent one.
  const ledgerBase = circlePath(circle.ref, "transactions");
  const returnUrl = parseReturnTo(searchParams.get(RETURN_TO_PARAM), { fallback: ledgerBase });

  const rawType = searchParams.get("type");
  const type = rawType === "expense" || rawType === "income" ? rawType : null;
  const rawMonth = searchParams.get("month");
  const month = isValidPlainMonth(rawMonth) ? rawMonth : currentMonth(new Date());

  // Set the instant we begin leaving (cancel or ordinary save).
  const [closing, setClosing] = useState(false);
  const close = () => {
    setClosing(true);
    navigate(returnUrl);
  };

  // An archived Circle is read-only and a missing / invalid `type` has nothing to create:
  // both eject to the return target. Replace so the dead create URL leaves no Back entry.
  useEffect(() => {
    if (!writable || type === null) {
      navigate(returnUrl, { replace: true });
    }
  }, [writable, type, navigate, returnUrl]);

  // This splash only ever shows while LEAVING — ejecting (archived / invalid type) or
  // closing (cancel / save); a valid open renders the form immediately, never this. So the
  // copy reflects the return, not an open. The inline `type === null` check also narrows
  // `type` to a concrete `TransactionType` for the adapter below.
  if (!writable || type === null || closing) {
    return <Splash label="Returning…" />;
  }

  return (
    <TransactionNewForm
      // Keyed by EVERY URL-owned create input — type AND month — so navigating between
      // create URLs (e.g. Back/Forward between two ledger CTAs) REMOUNTS the form rather
      // than reusing the previous context's field state: the shared controller
      // initializes its defaults (including the month-seeded Date) once per mount.
      key={`create-${type}-${month}`}
      circle={circle}
      type={type}
      selectedMonth={month}
      onClose={close}
    />
  );
}

/** The create-side adapter wiring: shared controller + shared body, no field tree here.
 * Ordinary Save closes to the validated `returnTo`; Save & new stays, snackbar + Title
 * focus owned here. */
function TransactionNewForm({
  circle,
  type,
  selectedMonth,
  onClose,
}: {
  circle: Circle;
  type: TransactionType;
  selectedMonth: PlainMonth;
  onClose: () => void;
}) {
  const { show } = useSnackbar();
  const controller = useTransactionForm({
    kind: "create",
    circle,
    type,
    selectedMonth,
    analytics: { surface: "circle_scoped", method: "manual" },
    onComplete: (result: TransactionFormResult) => {
      if (result.kind !== "created") {
        return;
      }
      if (result.intent === "save_and_new") {
        show("Transaction added. Ready for another.");
        document.getElementById("txn-title")?.focus();
        return;
      }
      onClose();
    },
  });
  return <TransactionFormBody controller={controller} onCancel={onClose} />;
}
