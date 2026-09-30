import type { CategoryRankingRow } from "~/lib/data.js";

/**
 * Category Ranking rows shared by the chart and shell component tests (ADR 0006: one
 * fixture). Deliberately mixes both sides of the diverging baseline and one Archived
 * Category so every branch has data: Salary (income, above the baseline), Groceries
 * (expense, below it), Old Subscriptions (expense, Archived → hatched fill).
 */
export const CATEGORY_RANKING_TEST_ROWS: CategoryRankingRow[] = [
  {
    categoryId: "cat-salary",
    name: "Salary",
    color: "teal",
    status: "active",
    type: "income",
    taggedTotalMinor: 500_000,
    txnCount: 1,
  },
  {
    categoryId: "cat-groceries",
    name: "Groceries",
    color: "green",
    status: "active",
    type: "expense",
    taggedTotalMinor: 7_350,
    txnCount: 3,
  },
  {
    categoryId: "cat-subscriptions",
    name: "Old Subscriptions",
    color: "orange",
    status: "archived",
    type: "expense",
    taggedTotalMinor: 2_100,
    txnCount: 1,
  },
];
