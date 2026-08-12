import { api } from "@pocketcircle/convex";
import { useConvexAuth, useQuery } from "convex/react";
import { useParams } from "react-router";
import { useCircle } from "~/routes/layouts/circle-layout.js";
import type { Transaction } from "./data.js";
import { MOCKS } from "./env.js";
import { mockEditableTransaction } from "./fixtures.js";
import { parseTransactionRef } from "./refs.js";
import { type Resolution, useResolvedRef } from "./use-resolved-ref.js";

/**
 * The Transaction object guard over the shared resolution primitive (ADR
 * 0016/0017), the second adapter the `useResolvedRef` state machine was extracted
 * for. It reads `transactionRef`, parses it, and subscribes to
 * `getEditableTransaction` scoped to the resolved Circle (from Outlet context) —
 * the edit target is fetched BY ID, never found in the visible ledger page, so an
 * off-month or off-page Transaction still opens (TXN-5).
 *
 * The server collapses missing / inaccessible / wrong-Circle / archived /
 * not-editable-by-viewer all to `null`, and this hands that `null` to the
 * primitive, which fires the generic unavailable-link snackbar and falls back to
 * the caller-supplied `fallback` — the validated `returnTo` origin the route
 * computed (issue #123), so closing an unavailable edit link returns the User to
 * where they opened it FROM (search, dashboard, ledger), or the Circle's
 * Transactions route when `returnTo` is absent/malformed. A stale title slug
 * canonicalizes in place via the primitive.
 *
 * The route always resolves `fallback` to a read-only-safe in-Circle path: an archived
 * Circle stays accessible, so its edit links land back on the return origin rather than
 * ejecting through the unavailable path. The origin may be the bare Circle root (a valid
 * `returnTo`) — still read-safe, since the dashboard renders read-only for an archived Circle.
 *
 * `enabled` lets the route stop resolving when it should not be showing the form at
 * all — skipping the query AND every effect (no fallback, no canonicalize), so the
 * route's own navigation always wins (see `transaction-edit.tsx`). Two cases need it:
 * a successful save that renames the Transaction changes its canonical ref, so a live
 * resolver would canonicalize the now-stale slug and race the close; and an archived
 * (read-only) Circle must drop the edit URL to the in-place ledger without ever taking
 * the generic unavailable-link path, even when the target itself resolves to `null`.
 */
export function useResolvedTransaction({
  enabled = true,
  fallback,
}: {
  enabled?: boolean;
  /** The validated `returnTo` origin (issue #123) — where an unavailable edit link
   * ejects to. The route computes it once via `parseReturnTo` and feeds it here AND uses
   * it as the close target, so the bad-link fallback and a normal close agree. */
  fallback: string;
}): Resolution<Transaction> {
  const circle = useCircle();
  const { transactionRef } = useParams();
  const { isAuthenticated } = useConvexAuth();

  const parsed = parseTransactionRef(transactionRef);
  const queried = useQuery(
    api.transactions.getEditableTransaction,
    parsed && enabled && !MOCKS && isAuthenticated
      ? { circleId: circle.id, transactionId: parsed.id }
      : "skip",
  );
  // Mock mode synthesizes the Transaction from the ref so E2E/offline can render the
  // edit form without a live backend; real mode uses the reactive query (ADR 0006).
  const value = MOCKS && parsed && enabled ? mockEditableTransaction(parsed.id) : queried;

  // `enabled` flows to the primitive, which goes fully inert when false — suppressing
  // EVERY effect, including the unparseable-ref report/snackbar for a malformed ref. So
  // an archived (read-only) Circle drops even a malformed edit URL to its own redirect,
  // never the generic unavailable-link path. `parsed` stays truthful.
  return useResolvedRef<Transaction>({
    rawRef: transactionRef,
    parsed: parsed != null,
    value,
    fallback,
    enabled,
  });
}
