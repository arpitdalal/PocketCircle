import { api } from "@pocketcircle/convex";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { MOCKS } from "../env.js";
import { MOCK_CIRCLES, MOCK_TRANSACTIONS } from "../fixtures.js";

/**
 * The single Circle view contract, derived from the Convex function's return
 * type so it cannot drift from the backend (ADR 0003). `toCircleView` in
 * `packages/convex/convex/operations.ts` is the one definition; both the real
 * `useQuery` path and the mock fixtures conform to this same type, so a field
 * change there surfaces here at typecheck time rather than as a runtime mismatch
 * between the two paths. `id` is an `Id<"circles">` branded string — the real
 * query already returns it; the mock fixtures cast their synthetic ids to match.
 */
export type Circle = NonNullable<FunctionReturnType<typeof api.circles.getCircle>>;

/**
 * The current User's Circles. In mock mode this returns fixture data and skips
 * the backend query so E2E renders without a live deployment (ADR 0006); in real
 * mode it is the reactive Convex query.
 */
export function useMyCircles(): Circle[] | undefined {
  const queried = useQuery(api.circles.listMyCircles, MOCKS ? "skip" : {});
  return MOCKS ? MOCK_CIRCLES : queried;
}

/**
 * The Create-Circle mutation (CS-0), exposed as the function the create form awaits.
 * Kept behind this seam (rather than `useMutation` in the route) so the route imports
 * no Convex internals — mirroring {@link useCreateCategory}. Returns the new Circle's
 * `Id<"circles">`, which the form turns into a canonical ref to navigate to (ADR 0016).
 */
export function useCreateCircle() {
  return useMutation(api.circles.createCircle);
}

/** Completes Circle Setup: answers + starter Categories. */
export function useCompleteCircleSetup() {
  return useMutation(api.circles.completeCircleSetup);
}

/** Renames a Circle (F0). */
export function useRenameCircle() {
  return useMutation(api.circles.renameCircle);
}

/** Changes a Circle's currency before the first Transaction (CS-3). */
export function useSetCurrency() {
  return useMutation(api.circles.setCurrency);
}

/** Enables or disables Personal Circle name auto-sync with Display Name (USR-2). */
export function useSetPersonalCircleNameAutoSync() {
  return useMutation(api.circles.setPersonalCircleNameAutoSync);
}

/** Updates Circle Settings: Color and Setup answers (CS-2). */
export function useUpdateCircleSettings() {
  return useMutation(api.circles.updateCircleSettings);
}

/** Archives a regular Circle (MEM-8). */
export function useArchiveCircle() {
  return useMutation(api.circles.archiveCircle);
}

/** Restores an archived Circle (MEM-8). */
export function useRestoreCircle() {
  return useMutation(api.circles.restoreCircle);
}

/** Whether the Circle has any Transaction (MEM-9 UI gate). `null` when inaccessible. */
export function useCircleHasTransactions(circleId: Circle["id"] | undefined) {
  const queried = useQuery(
    api.circles.circleHasTransactions,
    circleId === undefined || MOCKS ? "skip" : { circleId },
  );
  if (MOCKS) {
    return circleId === undefined ? undefined : MOCK_TRANSACTIONS.length > 0;
  }
  return queried;
}

/** Deletes an owner-only, zero-transaction regular Circle (MEM-9). */
export function useDeleteCircle() {
  return useMutation(api.circles.deleteCircle);
}

/** Splits a Personal-first circle list into active vs archived for switcher/home grouping. */
export function partitionCirclesByStatus(circles: Circle[]) {
  const active: Circle[] = [];
  const archived: Circle[] = [];
  for (const circle of circles) {
    if (circle.status === "archived") {
      archived.push(circle);
    } else {
      active.push(circle);
    }
  }
  return { active, archived };
}
