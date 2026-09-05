import type { CashFlowSeriesEntry } from "./cash-flow-trend-chart.js";

/** Shared Cash Flow Trend series for chart component tests (ADR 0006: one fixture). */
export const CASH_FLOW_TREND_TEST_SERIES: CashFlowSeriesEntry[] = [
  { month: "2026-07", incomeMinor: 100000, expenseMinor: 60000, netMinor: 40000 },
  { month: "2026-08", incomeMinor: 120000, expenseMinor: 85000, netMinor: 35000 },
];
