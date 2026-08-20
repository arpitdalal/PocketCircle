import { type OptionalRestArgsOrSkip, useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useState } from "react";

/**
 * Prefer a freshly defined Convex query result; otherwise keep `previous`.
 * Convex's `useQuery` returns `undefined` between arg changes — callers that
 * need a continuous tree (NumberFlow / Recharts, ADR 0032) keep the last
 * defined value. `null` is a real result (inaccessible) and replaces previous.
 */
export function retainDefinedQueryResult<T>(result: T | undefined, previous: T | undefined) {
  return result !== undefined ? result : previous;
}

/**
 * Keeps the last defined query result across arg-change loads. Uses React's
 * adjust-state-during-render pattern (not a ref) so the retained value is a
 * render input — required by react-hooks/refs and ADR 0025.
 *
 * Syncs the snapshot only when the loading gap opens/closes (`undefined` ↔
 * defined), not on every defined identity change. Convex (and our test doubles)
 * may allocate a new result object each render while args are unchanged;
 * treating that as a state update would infinite-loop.
 */
export function useRetainedQueryResult<T>(result: T | undefined) {
  // Box writes in `() => value` so a function-valued T is stored as data.
  // react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers -- retained previous result IS read during render to bridge Convex arg-change `undefined` (ADR 0032); same adjust-state-during-render pattern as useValueChange.
  const [retained, setRetained] = useState(() => result);
  const [wasLoading, setWasLoading] = useState(() => result === undefined);
  const loading = result === undefined;

  if (loading !== wasLoading) {
    setWasLoading(() => loading);
    if (result !== undefined) {
      setRetained(() => result);
    }
  }

  return {
    value: retainDefinedQueryResult(result, retained),
    isPending: loading && retained !== undefined,
  };
}

/**
 * Like `useQuery`, but keeps the last defined result while args change and the
 * next subscription is still loading. Pattern from
 * https://stack.convex.dev/help-my-app-is-overreacting (state, not ref).
 *
 * Still `undefined` on the very first load (no prior result).
 */
export function useStableQuery<Query extends FunctionReference<"query">>(
  query: Query,
  ...args: OptionalRestArgsOrSkip<Query>
) {
  const result = useQuery(query, ...args);
  return useRetainedQueryResult(result).value;
}
