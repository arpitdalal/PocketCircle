/**
 * Headline totals use NumberFlow (`AnimatedMoney`). Digit strips live in open
 * shadow DOM, so parent `textContent` / `getByText` are not the formatted
 * amount — assert the light-DOM img name / `data-money` instead.
 */
export function moneyAmount(amount: string) {
  return `[data-money=${JSON.stringify(amount)}]`;
}

type RoleQueries = {
  getByRole: (role: "img", options: { name: string }) => HTMLElement;
  queryByRole: (role: "img", options: { name: string }) => HTMLElement | null;
};

export function getHeadlineMoney(scope: RoleQueries, amount: string) {
  return scope.getByRole("img", { name: amount });
}

export function queryHeadlineMoney(scope: RoleQueries, amount: string) {
  return scope.queryByRole("img", { name: amount });
}
