import { api } from "@pocketcircle/convex";
import type { HomeRangeMonths } from "@pocketcircle/domain";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { MOCKS } from "../env.js";
import { MOCK_CIRCLES } from "../fixtures.js";

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

/**
 * The Home Summary (GH-273): currency-scoped, multi-Circle aggregate with
 * exclusions. `undefined` while loading. Mock mode returns fixtures and skips
 * the backend (ADR 0006).
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
  return MOCKS ? MOCK_HOME_SUMMARY : queried;
}

/** Exclude a Circle from the Home Summary scope. */
export function useExcludeCircle() {
  return useMutation(api.homeSummary.excludeCircle);
}

/** Include a Circle back into the Home Summary scope. */
export function useIncludeCircle() {
  return useMutation(api.homeSummary.includeCircle);
}
