/**
 * Headline totals use NumberFlow (`AnimatedMoney`). Digit strips live in open
 * shadow DOM, so parent `textContent` / plain `getByText` are unreliable —
 * assert the visually-hidden accessible amount (`.sr-only` inside `[data-money]`).
 */
type MoneyQueries = {
  getByText: (text: string, options?: { selector?: string }) => HTMLElement;
  queryByText: (text: string, options?: { selector?: string }) => HTMLElement | null;
};

export function getHeadlineMoney(scope: MoneyQueries, amount: string) {
  return scope.getByText(amount, { selector: ".sr-only" });
}

export function queryHeadlineMoney(scope: MoneyQueries, amount: string) {
  return scope.queryByText(amount, { selector: ".sr-only" });
}
