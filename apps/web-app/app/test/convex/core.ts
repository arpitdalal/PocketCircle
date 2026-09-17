import { type FunctionReference, getFunctionName } from "convex/server";
import { useSyncExternalStore } from "react";
import type { Mock } from "vitest";
import { vi } from "vitest";
import { type AccountDeletionState, accountDeletionDouble } from "./account-deletion.js";
import { type ActivationState, activationDouble } from "./activation.js";
import { type CategoriesState, categoriesDouble } from "./categories.js";
import { type CirclesState, circlesDouble } from "./circles.js";
import type { EntityDouble, PaginatedPage } from "./contract.js";
import { type DashboardState, dashboardDouble } from "./dashboard.js";
import { type FeedbackState, feedbackDouble } from "./feedback.js";
import { type HistoryState, historyDouble } from "./history.js";
import { type HomeSummaryState, homeSummaryDouble } from "./home-summary.js";
import { type InvitationsState, invitationsDouble } from "./invitations.js";
import { type LedgerState, ledgerDouble } from "./ledger.js";
import { type McpState, mcpDouble } from "./mcp.js";
import { type MembersState, membersDouble } from "./members.js";
import { type NotificationsState, notificationsDouble } from "./notifications.js";
import { type PushSubscriptionsState, pushSubscriptionsDouble } from "./push-subscriptions.js";
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
  PushSubscriptionsState &
  FeedbackState &
  AccountDeletionState &
  ActivationState &
  HomeSummaryState &
  McpState;

const ENTITY_DOUBLES: Array<(state: ConvexState) => EntityDouble> = [
  circlesDouble,
  categoriesDouble,
  membersDouble,
  invitationsDouble,
  transactionsDouble,
  ledgerDouble,
  dashboardDouble,
  historyDouble,
  notificationsDouble,
  pushSubscriptionsDouble,
  usersDouble,
  feedbackDouble,
  accountDeletionDouble,
  activationDouble,
  homeSummaryDouble,
  mcpDouble,
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
  useQueries: vi.fn(),
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

/**
 * The subset of Convex's optimistic `localStore` the doubles implement — the two
 * methods `withOptimisticUpdate` callbacks use. Exported so a test can type its
 * callback without leaning on the mock's `any`.
 */
export interface OptimisticLocalStore {
  getQuery: (query: FunctionReference<"query">, args: Record<string, unknown>) => unknown;
  setQuery: (
    query: FunctionReference<"query">,
    args: Record<string, unknown>,
    value: unknown,
  ) => void;
}

type OptimisticUpdate = (localStore: OptimisticLocalStore, args: unknown) => void;

/** Configures what each doubled Convex subscription/mutation returns for one test.
 * Call before rendering so the first render reads the intended state. */
export function configureConvex(state: ConvexState = {}) {
  const merged = mergeEntityDoubles(state);
  const noop = vi.fn();
  /**
   * Optimistic writes, mirroring the Convex client's layering: every in-flight mutation
   * owns its own layer, and reads resolve newest-layer-first over the entity doubles.
   * A mutation may only ever add or drop ITS layer, so a rollback cannot discard a
   * concurrent mutation's optimistic state.
   *
   * ponytail: a settled layer is folded into `settledWrites` and kept, rather than
   * dropped the way Convex drops it once the server result arrives. Ceiling: an
   * optimistic value can shadow a double that models the same write differently.
   * Upgrade path — make the mutation doubles apply their own writes to entity state,
   * then delete `settledWrites` and let the fold become a plain drop.
   */
  const pendingWrites: Array<Map<string, unknown>> = [];
  const settledWrites = new Map<string, unknown>();
  const readWrite = (key: string) => {
    for (let i = pendingWrites.length - 1; i >= 0; i -= 1) {
      const layer = pendingWrites[i];
      if (layer?.has(key)) {
        return { found: true, value: layer.get(key) };
      }
    }
    if (settledWrites.has(key)) {
      return { found: true, value: settledWrites.get(key) };
    }
    return { found: false, value: undefined };
  };
  let queryEpoch = 0;
  const queryListeners = new Set<() => void>();
  const bumpQueries = () => {
    queryEpoch += 1;
    for (const listener of queryListeners) {
      listener();
    }
  };
  const queryCacheKey = (name: string, args: Record<string, unknown>) =>
    `${name}:${JSON.stringify(args)}`;

  const readQuery = (name: string, args: Record<string, unknown>) => {
    const key = queryCacheKey(name, args);
    const optimistic = readWrite(key);
    if (optimistic.found) {
      return optimistic.value;
    }
    const handler = merged.queries[name];
    if (!handler) return undefined;
    return handler(args);
  };

  const convexQuery = vi.fn(
    async (fn: FunctionReference<"query">, args: Record<string, unknown>) => {
      const name = getFunctionName(fn);
      return readQuery(name, args);
    },
  );

  convexReactMock.useConvex.mockImplementation(() => ({ query: convexQuery }));

  // Mirror Convex client referential stability: same args + deep-equal payload ⇒
  // same object identity. Unstable identities break adjust-state-during-render
  // retention (infinite setState loops) and don't match production.
  const queryResultCache = new Map<string, unknown>();

  convexReactMock.useQuery.mockImplementation(
    (fn: FunctionReference<"query">, args: Record<string, unknown> | "skip") => {
      useSyncExternalStore(
        (onStoreChange) => {
          queryListeners.add(onStoreChange);
          return () => {
            queryListeners.delete(onStoreChange);
          };
        },
        () => queryEpoch,
        () => 0,
      );
      if (args === "skip") return undefined;
      const name = getFunctionName(fn);
      const next = readQuery(name, args);
      const key = queryCacheKey(name, args);
      if (next === undefined) {
        queryResultCache.delete(key);
        return undefined;
      }
      if (queryResultCache.has(key)) {
        const previous = queryResultCache.get(key);
        if (JSON.stringify(previous) === JSON.stringify(next)) {
          return previous;
        }
      }
      queryResultCache.set(key, next);
      return next;
    },
  );

  convexReactMock.useQueries.mockImplementation(
    (
      queries: Record<
        string,
        { query: FunctionReference<"query">; args: Record<string, unknown> } | "skip"
      >,
    ) => {
      useSyncExternalStore(
        (onStoreChange) => {
          queryListeners.add(onStoreChange);
          return () => {
            queryListeners.delete(onStoreChange);
          };
        },
        () => queryEpoch,
        () => 0,
      );
      const out: Record<string, unknown> = {};
      for (const [key, spec] of Object.entries(queries)) {
        if (spec === "skip") {
          out[key] = undefined;
          continue;
        }
        out[key] = readQuery(getFunctionName(spec.query), spec.args);
      }
      return out;
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

  /** The `localStore` Convex hands an optimistic update, bound to one mutation's layer. */
  const localStoreFor = (layer: Map<string, unknown>) => ({
    getQuery(query: FunctionReference<"query">, queryArgs: Record<string, unknown>) {
      return readQuery(getFunctionName(query), queryArgs);
    },
    setQuery(
      query: FunctionReference<"query">,
      queryArgs: Record<string, unknown>,
      value: unknown,
    ) {
      layer.set(queryCacheKey(getFunctionName(query), queryArgs), value);
      bumpQueries();
    },
  });

  function buildMutation(name: string, optimisticUpdate: OptimisticUpdate | undefined) {
    const run = async (args: unknown) => {
      const m = merged.mutations[name] ?? noop;
      const layer = new Map<string, unknown>();
      if (optimisticUpdate) {
        pendingWrites.push(layer);
        optimisticUpdate(localStoreFor(layer), args);
      }
      const dropLayer = () => {
        const index = pendingWrites.indexOf(layer);
        if (index !== -1) {
          pendingWrites.splice(index, 1);
        }
      };
      try {
        const result = await m(args);
        // The write landed, so this layer stops being a guess: fold it in and stop
        // shadowing later mutations' layers with it.
        for (const [key, value] of layer) {
          settledWrites.set(key, value);
        }
        dropLayer();
        // Convex re-runs affected queries once a mutation lands and pushes any changed
        // result, so subscribers update even when the component that called the mutation
        // is not the one subscribed. Without this, a state-changing double
        // (`activation: () => dismissed ? … : …`) would only appear to change if the
        // caller happened to re-render — a property of the test, not of the app.
        bumpQueries();
        return result;
      } catch (error) {
        // Rollback drops only this mutation's guesses (mirrors Convex): queries fall back
        // to the entity doubles, and any concurrent mutation's layer is left alone.
        dropLayer();
        bumpQueries();
        throw error;
      }
    };
    return Object.assign(run, {
      withOptimisticUpdate: (update: OptimisticUpdate) => buildMutation(name, update),
    });
  }

  // Convex's `useMutation` is memoized per function reference, so the function it
  // returns is referentially stable across renders. Components depend on that: an
  // effect listing the mutation in its deps (e.g. the activation checklist's
  // self-initialize) would otherwise re-run on every render and re-fire the mutation.
  const mutationCache = new Map<string, ReturnType<typeof buildMutation>>();

  convexReactMock.useMutation.mockImplementation((fn: FunctionReference<"mutation">) => {
    const name = getFunctionName(fn);
    const cached = mutationCache.get(name);
    if (cached) {
      return cached;
    }
    const mutation = buildMutation(name, undefined);
    mutationCache.set(name, mutation);
    return mutation;
  });
}
