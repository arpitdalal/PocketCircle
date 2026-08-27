/**
 * Entity-scoped Convex test doubles; import from `~/test/convex-react.js` (barrel).
 */

export { AppTestProviders } from "./app-test-providers.js";
/**
 * Shared view-shape builders for route and component tests — one canonical default per
 * model (`Circle`, `Category`, `Member`, `Transaction`, detail, history event), typed
 * against `~/lib/data.js` so a contract change fails typecheck here. Each helper takes a
 * partial override so tests state only what differs (CLAUDE.md: one helper, not copy-pasted
 * fixtures tweaked per file). Ids default to stable slugs; pass overrides for the rest.
 */
export { makeAccountDeletionBlocker } from "./convex/account-deletion.js";
export { makeActivationChecklistView, makeEligibleCircle } from "./convex/activation.js";
export { makeCategoryDetailView, makeCategoryView } from "./convex/categories.js";
export { makeCircleView } from "./convex/circles.js";
export type { ConvexState } from "./convex/core.js";
export { configureConvex, convexHelpersReactMock, convexReactMock } from "./convex/core.js";
export { makeHistoryEventView } from "./convex/history.js";
export { makeHomeSummaryRecent, makeHomeSummaryView } from "./convex/home-summary.js";
export { testId } from "./convex/ids.js";
export { makeMcpHandoffView } from "./convex/mcp.js";
export { makeMemberView } from "./convex/members.js";
export { makeNotificationView } from "./convex/notifications.js";
export {
  circleLayoutHeadingChrome,
  renderCircleRoutes,
  renderInCircle,
  renderRoutes,
  renderWithRouter,
} from "./convex/render.js";
export { makeTransactionDetailView, makeTransactionView } from "./convex/transactions.js";
export { makeCurrentUserView } from "./convex/users.js";
export { deferredMutationFn, deferredValue } from "./deferred.js";
export {
  assertFilterPanelDiscardsDraftOnClose,
  FILTER_PANEL_CLOSE_MEDIUMS,
  type FilterPanelCloseMedium,
} from "./filter-panel-draft-contract.js";
export {
  flushIntersectionObserverStub,
  IntersectionObserverStub,
  installIntersectionObserverStub,
} from "./intersection-observer-stub.js";
export {
  inlineCreateTransactionFormCategory,
  pickCombobox,
  pickTransactionFormCategory,
} from "./transaction-category-picker.js";
