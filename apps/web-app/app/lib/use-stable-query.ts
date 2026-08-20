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
 * - Syncs `retained` whenever a defined result's identity changes (live updates),
 *   and when leaving the `undefined` gap. Convex keeps referential stability
 *   until data changes; our test `useQuery` double mirrors that.
 * - `resetKey` clears the bridge (e.g. `circleId`) so a reused route never shows
 *   the previous Circle's totals/series under the new chrome.
 */
export function useRetainedQueryResult<T>(
  result: T | undefined,
  options?: { resetKey?: unknown },
) {
  const resetKey = options?.resetKey;
  // Box writes in `() => value` so a function-valued T is stored as data.
  // react-doctor-disable-next-line react-doctor/rerender-state-only-in-handlers -- retained previous result IS read during render to bridge Convex arg-change `undefined` (ADR 0032); same adjust-state-during-render pattern as useValueChange.
  const [retained, setRetained] = useState(() => result);
  const [prevResetKey, setPrevResetKey] = useState(() => resetKey);

  if (!Object.is(resetKey, prevResetKey)) {
    setPrevResetKey(() => resetKey);
    setRetained(() => result);
  } else if (result !== undefined && !Object.is(result, retained)) {
    setRetained(() => result);
  }

  return {
    value: retainDefinedQueryResult(result, retained),
    isPending: result === undefined && retained !== undefined,
  };
}

/**
 * Like `useQuery`, but keeps the last defined result while args change and the
 * next subscription is still loading. Pattern from
 * https://stack.convex.dev/help-my-app-is-overreacting (state, not ref).
 *
 * Still `undefined` on the very first load (no prior result). Pass `resetKey`
 * (e.g. Circle id) to drop the bridge when identity should not carry over.
 */
export function useStableQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: OptionalRestArgsOrSkip<Query>[0],
  options?: { resetKey?: unknown },
) {
  const result = useQuery(query, args);
  return useRetainedQueryResult(result, options);
}
