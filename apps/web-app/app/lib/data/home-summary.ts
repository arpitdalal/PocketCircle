import { api } from "@pocketcircle/convex";
import type { HomeRangeMonths } from "@pocketcircle/domain";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRef } from "react";
import { MOCKS } from "../env.js";
import { MOCK_CIRCLES } from "../fixtures.js";
import { retainDefinedQueryResult } from "../use-stable-query.js";

/**
 * The Home Summary view contract, derived from the Convex function's return type
 * so it cannot drift from the backend (ADR 0003).
 */
export type HomeSummary = FunctionReturnType<typeof api.homeSummary.getHomeSummary>;
export type HomeSummaryContribution = HomeSummary["contributions"][number];
export type HomeSummaryRecentTransaction = HomeSummary["recent"][number];
export type HomeSummaryCircle = HomeSummary["circles"][number];
export type HomeSummarySeries = HomeSummary["series"][number];

/** Mock Home Summary for MOCKS mode (dev without backend). */
const mockCircle = MOCK_CIRCLES[0];
if (!mockCircle) {
  throw new Error("MOCK_CIRCLES is empty");
}

const MOCK_HOME_SUMMARY: HomeSummary = {
  selectedCurrency: "USD",
  availableCurrencies: ["USD"],
  range: 1,
  series: [{ month: "2026-08", incomeMinor: 120000, expenseMinor: 85000, netMinor: 35000 }],
  totals: { incomeMinor: 120000, expenseMinor: 85000, netMinor: 35000 },
  contributions: [
    {
      circleId: mockCircle.id,
      circleRef: mockCircle.ref,
      name: mockCircle.name,
      kind: "personal",
      incomeMinor: 120000,
      expenseMinor: 85000,
      netMinor: 35000,
    },
  ],
  recent: [],
  includedCount: 1,
  availableCount: 1,
  circles: [
    {
      id: mockCircle.id,
      ref: mockCircle.ref,
      name: mockCircle.name,
      kind: "personal",
      currency: "USD",
      status: "active",
      included: true,
    },
  ],
};

export type HomeSummaryView = {
  /** Last defined summary — kept across currency/range arg changes (ADR 0032). */
  summary: HomeSummary | undefined;
  /**
   * True while args changed and the live query is still loading. Callers must not
   * URL-canonicalize from `summary` while pending — that would rewrite the user's
   * in-flight currency/range selection back to the stale summary.
   */
  isPending: boolean;
};

/**
 * The Home Summary (GH-273): currency-scoped, multi-Circle aggregate with
 * exclusions. Mock mode returns fixtures and skips the backend (ADR 0006).
 *
 * Keeps the previous summary while currency/range args reload so NumberFlow /
 * Recharts stay mounted (ADR 0032). Exposes `isPending` so URL canonicalization
 * only runs on a fresh result.
 */
export function useHomeSummary(options?: { currency?: string; range?: HomeRangeMonths }) {
  const queried = useQuery(
    api.homeSummary.getHomeSummary,
    MOCKS
      ? "skip"
      : {
          ...(options?.currency ? { currency: options.currency } : {}),
          ...(options?.range ? { range: options.range } : {}),
        },
  );
  const stored = useRef(queried);
  const isPending = queried === undefined && stored.current !== undefined;
  stored.current = retainDefinedQueryResult(queried, stored.current);

  if (MOCKS) {
    return { summary: MOCK_HOME_SUMMARY, isPending: false } satisfies HomeSummaryView;
  }
  return { summary: stored.current, isPending } satisfies HomeSummaryView;
}

/** Exclude a Circle from the Home Summary scope. */
export function useExcludeCircle() {
  return useMutation(api.homeSummary.excludeCircle);
}

/** Include a Circle back into the Home Summary scope. */
export function useIncludeCircle() {
  return useMutation(api.homeSummary.includeCircle);
}
