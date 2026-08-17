import { api } from "@pocketcircle/convex";
import { getFunctionName } from "convex/server";
import type { Mock } from "vitest";
import type { HomeSummary } from "~/lib/data/home-summary.js";
import type { EntityDouble } from "./contract.js";
import { resolveWith } from "./contract.js";
import { testId } from "./ids.js";
import { makeTransactionView } from "./transactions.js";

export interface HomeSummaryState {
  /** `getHomeSummary` — `undefined` ≡ loading. A function resolves per query args. */
  homeSummary?: HomeSummary | ((args: Record<string, unknown>) => HomeSummary | undefined);
  excludeCircle?: Mock;
  includeCircle?: Mock;
}

export function homeSummaryDouble(state: HomeSummaryState): EntityDouble {
  const { homeSummary, excludeCircle, includeCircle } = state;
  return {
    queries: {
      [getFunctionName(api.homeSummary.getHomeSummary)]: (args) => resolveWith(homeSummary, args),
    },
    mutations: {
      [getFunctionName(api.homeSummary.excludeCircle)]: excludeCircle,
      [getFunctionName(api.homeSummary.includeCircle)]: includeCircle,
    },
  };
}

export function makeHomeSummaryRecent(
  over: Partial<HomeSummary["recent"][number]> = {},
): HomeSummary["recent"][number] {
  return {
    ...makeTransactionView({
      id: testId("t1"),
      ref: "rent-t1",
      title: "Rent",
      amountMinorUnits: 50000,
      date: "2026-08-01",
      month: "2026-08",
    }),
    circleId: testId("c1"),
    circleRef: "trip-c1",
    circleName: "Trip",
    circleKind: "regular",
    ...over,
  };
}

/** Default Home Summary fixture for tests — one USD Circle, all included. */
export function makeHomeSummaryView(over: Partial<HomeSummary> = {}): HomeSummary {
  return {
    selectedCurrency: "USD",
    availableCurrencies: ["USD"],
    range: 1,
    series: [{ month: "2026-08", incomeMinor: 100000, expenseMinor: 60000, netMinor: 40000 }],
    totals: { incomeMinor: 100000, expenseMinor: 60000, netMinor: 40000 },
    contributions: [
      {
        circleId: testId("c1"),
        circleRef: "trip-c1",
        name: "Trip",
        kind: "regular",
        incomeMinor: 100000,
        expenseMinor: 60000,
        netMinor: 40000,
      },
    ],
    recent: [],
    includedCount: 1,
    availableCount: 1,
    circles: [
      {
        id: testId("c1"),
        ref: "trip-c1",
        name: "Trip",
        kind: "regular",
        currency: "USD",
        status: "active",
        included: true,
      },
    ],
    ...over,
  };
}
