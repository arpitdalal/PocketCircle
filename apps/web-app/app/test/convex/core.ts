import { type FunctionReference, getFunctionName } from "convex/server";
import type { Mock } from "vitest";
import { vi } from "vitest";
import { type AccountDeletionState, accountDeletionDouble } from "./account-deletion.js";
import { type ActivationState, activationDouble } from "./activation.js";
import { type CategoriesState, categoriesDouble } from "./categories.js";
import { type CirclesState, circlesDouble } from "./circles.js";
import type { PaginatedPage } from "./contract.js";
import { type DashboardState, dashboardDouble } from "./dashboard.js";
import { type FeedbackState, feedbackDouble } from "./feedback.js";
import { type HistoryState, historyDouble } from "./history.js";
import { type HomeSummaryState, homeSummaryDouble } from "./home-summary.js";
import { type InvitationsState, invitationsDouble } from "./invitations.js";
import { type LedgerState, ledgerDouble } from "./ledger.js";
import { type MembersState, membersDouble } from "./members.js";
import { type NotificationsState, notificationsDouble } from "./notifications.js";
import { type TransactionsState, transactionsDouble } from "./transactions.js";
import { type UsersState, usersDouble } from "./users.js";

export type ConvexState = CirclesState &
  CategoriesState &
  MembersState &
  InvitationsState &
  TransactionsState &
  LedgerState &
  DashboardState &
  HistoryState &
  UsersState &
  NotificationsState &
  FeedbackState &
  AccountDeletionState &
  ActivationState &
  HomeSummaryState;

const ENTITY_DOUBLES = [
  circlesDouble,
  categoriesDouble,
  membersDouble,
  invitationsDouble,
  transactionsDouble,
  ledgerDouble,
  dashboardDouble,
  historyDouble,
  notificationsDouble,
  usersDouble,
  feedbackDouble,
  accountDeletionDouble,
  activationDouble,
  homeSummaryDouble,
];
function mergeEntityDoubles(state: ConvexState) {
  const queries: Record<string, (args: Record<string, unknown>) => unknown> = {};
  const paginatedQueries: Record<string, (args: Record<string, unknown>) => PaginatedPage> = {};
  const mutations: Record<string, Mock | undefined> = {};
  for (const build of ENTITY_DOUBLES) {
    const d = build(state);
    Object.assign(queries, d.queries);
    Object.assign(paginatedQueries, d.paginatedQueries);
    Object.assign(mutations, d.mutations);
  }
  return { queries, paginatedQueries, mutations };
}

/**
 * One source of truth for the Convex network boundary in component tests. Every
 * route/component test doubles ONLY `convex/react` (the reactive client) and runs
 * the real `~/lib/data.js` hooks + real route logic against it, per ADR 0006 (mock
 * at the vendor edge, never over our own logic). Install it in a test file with:
 *
 * ```ts
 * vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
 * ```
 *
 * then drive each test's backend state through {@link configureConvex}. The doubles
 * dispatch by the Convex function's stable name (`module:function`), so they model
 * the backend contract — a test fails if the route subscribes to the wrong query or
 * drops an arg (e.g. `includeArchived`).
 */
export const convexReactMock = {
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  usePaginatedQuery: vi.fn(),
  useConvex: vi.fn(),
  // Imported (not executed) by the Circle layout's resolver that some routes pull
  // in — present so the named import resolves; never relied upon here.
  useConvexAuth: vi.fn(() => ({ isAuthenticated: true, isLoading: false })),
};

/**
 * The double for `convex-helpers/react` — the same vendor edge as `convex/react`
 * (its hooks build on `useConvex`/`useQueries` from there). `useCategoriesPage`
 * consumes the STREAM-paginated `filterCategories` through the helper's
 * `usePaginatedQuery` (it pins `endCursor` so reactive changes can't shift page
 * boundaries — see `data.ts`); tests double it with the SAME dispatching mock so
 * the per-function-name contract modelling below serves both import paths.
 * Install alongside the convex/react mock:
 *
 * ```ts
 * vi.mock("convex-helpers/react", async () =>
 *   (await import("~/test/convex-react.js")).convexHelpersReactMock);
 * ```
 */
export const convexHelpersReactMock = {
  usePaginatedQuery: convexReactMock.usePaginatedQuery,
};

/** Configures what each doubled Convex subscription/mutation returns for one test.
 * Call before rendering so the first render reads the intended state. */
export function configureConvex(state: ConvexState = {}) {
  const merged = mergeEntityDoubles(state);
  const noop = vi.fn();
  const convexQuery = vi.fn(
    async (fn: FunctionReference<"query">, args: Record<string, unknown>) => {
      const name = getFunctionName(fn);
      const handler = merged.queries[name];
      if (handler) return handler(args);
      return undefined;
    },
  );

  convexReactMock.useConvex.mockImplementation(() => ({ query: convexQuery }));

  convexReactMock.useQuery.mockImplementation(
    (fn: FunctionReference<"query">, args: Record<string, unknown> | "skip") => {
      if (args === "skip") return undefined;
      const name = getFunctionName(fn);
      const handler = merged.queries[name];
      if (handler) return handler(args);
      return undefined;
    },
  );

  convexReactMock.usePaginatedQuery.mockImplementation(
    (fn: FunctionReference<"query">, args: Record<string, unknown> | "skip") => {
      if (args === "skip") {
        return { results: [], status: "Exhausted", loadMore: () => {} };
      }
      const name = getFunctionName(fn);
      const handler = merged.paginatedQueries[name];
      if (handler) return handler(args);
      return { results: [], status: "Exhausted", loadMore: () => {} };
    },
  );

  convexReactMock.useMutation.mockImplementation((fn: FunctionReference<"mutation">) => {
    const name = getFunctionName(fn);
    const m = merged.mutations[name];
    return m ?? noop;
  });
}
