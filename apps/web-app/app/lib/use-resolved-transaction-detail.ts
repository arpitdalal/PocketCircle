import { api } from "@pocketcircle/convex";
import { useConvexAuth, useQuery } from "convex/react";
import { useParams } from "react-router";
import { useCircle } from "~/routes/layouts/circle-layout.js";
import type { TransactionDetail } from "./data.js";
import { MOCKS } from "./env.js";
import { mockTransactionDetail } from "./fixtures.js";
import { parseTransactionRef } from "./refs.js";
import { type Resolution, useResolvedRef } from "./use-resolved-ref.js";

/**
 * The Transaction DETAIL object guard over the shared resolution primitive (ADR
 * 0016/0017), the reference object adapter the `useResolvedRef` state machine was
 * extracted for. It reads `transactionRef`, parses it, and subscribes to
 * `getTransaction` scoped to the resolved Circle (from Outlet context) — the detail
 * target is fetched BY ID, so a Transaction outside the visible ledger page still opens.
 *
 * The sibling of {@link useResolvedTransaction} (which resolves the EDIT target via
 * `getEditableTransaction`): both parse the same ref the same way, but this one reads the
 * read-only detail query, so it resolves for ANY current Member and for an archived
 * (frozen) Transaction too — the server only collapses missing / inaccessible / wrong-
 * Circle to `null`. That `null` flows to the primitive, which fires the generic
 * unavailable-link snackbar and falls back to the caller-supplied `fallback` — the
 * validated `returnTo` origin the route computed (issue #123), so an unavailable detail
 * link returns the User to where they opened it FROM, or the Circle's Transactions route
 * when `returnTo` is absent/malformed; a stale title slug canonicalizes in place. There
 * is no `enabled` gate: a detail surface has no save-rename race or write-when-archived
 * case to suppress, so resolution always runs.
 */
export function useResolvedTransactionDetail({
  fallback,
}: {
  /** The validated `returnTo` origin (issue #123) the route also uses as its Back target. */
  fallback: string;
}): Resolution<TransactionDetail> {
  const circle = useCircle();
  const { transactionRef } = useParams();
  const { isAuthenticated } = useConvexAuth();

  const parsed = parseTransactionRef(transactionRef);
  const queried = useQuery(
    api.transactions.getTransaction,
    parsed && !MOCKS && isAuthenticated
      ? { circleId: circle.id, transactionId: parsed.id }
      : "skip",
  );
  // Mock mode synthesizes the detail from the ref so E2E/offline can render the surface
  // without a live backend; real mode uses the reactive query (ADR 0006).
  const value = MOCKS && parsed ? mockTransactionDetail(parsed.id) : queried;

  return useResolvedRef<TransactionDetail>({
    rawRef: transactionRef,
    parsed: parsed != null,
    value,
    fallback,
  });
}
