import { currentMonth, isValidPlainMonth } from "@pocketcircle/domain";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Splash } from "~/components/splash.js";
import { TransactionForm } from "~/components/transaction-form/index.js";
import { circlePath } from "~/lib/circle-path.js";
import { parseReturnTo, RETURN_TO_PARAM } from "~/lib/return-to-url.js";
import { useCircle } from "~/routes/layouts/circle-layout.js";

/**
 * The new-Transaction route — `/circles/:circleRef/transactions/new` (issue #96). A
 * dedicated create page so the ledger no longer stacks a create form above its rows,
 * mirroring `transaction-edit.tsx`'s lifecycle (the up-to-date object-route template).
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
 * Close (cancel / successful save), the invalid-`type` guard, and the archived-Circle
 * redirect ALL land on the validated `returnTo` (issue #123): the exact filtered ledger
 * URL the CTA was opened FROM, or — when absent / malformed / out-of-scope — the Circle's
 * ledger (anti-enumeration). Unlike edit there is no target to resolve, so no resolver: a
 * create page has nothing to fetch by id. `closing` + `Splash` keep the form from
 * flashing while the close navigation is in flight, exactly as edit does.
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

  // Set the instant we begin leaving (cancel or successful save).
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
  // `type` to a concrete `TransactionType` for the form below.
  if (!writable || type === null || closing) {
    return <Splash label="Returning…" />;
  }

  return (
    <TransactionForm
      // Keyed by type so navigating expense↔income (e.g. Back/Forward between the two
      // CTAs) REMOUNTS the form rather than reusing the previous type's field state —
      // the same id-keying the inline ledger form used.
      key={`create-${type}`}
      circle={circle}
      mode={{ kind: "create", type, selectedMonth: month }}
      onClose={close}
    />
  );
}
