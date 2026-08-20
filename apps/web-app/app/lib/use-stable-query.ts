import { type OptionalRestArgsOrSkip, useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useRef } from "react";

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
 * Like `useQuery`, but keeps the last defined result while args change and the
 * next subscription is still loading. Pattern from
 * https://stack.convex.dev/help-my-app-is-overreacting.
 *
 * Still `undefined` on the very first load (no prior result).
 */
export function useStableQuery<Query extends FunctionReference<"query">>(
  query: Query,
  ...args: OptionalRestArgsOrSkip<Query>
) {
  const result = useQuery(query, ...args);
  const stored = useRef(result);
  stored.current = retainDefinedQueryResult(result, stored.current);
  return stored.current;
}
