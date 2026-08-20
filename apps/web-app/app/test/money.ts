/**
 * Headline totals use NumberFlow (`AnimatedMoney`). Digit strips live in open
 * shadow DOM, so parent `textContent` / `getByText` are not the formatted
 * amount — assert the light-DOM `data-money` contract (and its sr-only text).
 */
type MoneyQueries = {
  getByText: (text: string, options?: { selector?: string }) => HTMLElement;
  queryByText: (text: string, options?: { selector?: string }) => HTMLElement | null;
};

export function getHeadlineMoney(scope: MoneyQueries, amount: string) {
  return scope.getByText(amount, { selector: "[data-money]" });
}

export function queryHeadlineMoney(scope: MoneyQueries, amount: string) {
  return scope.queryByText(amount, { selector: "[data-money]" });
}
