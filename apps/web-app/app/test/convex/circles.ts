import { api } from "@pocketcircle/convex";
import { getFunctionName } from "convex/server";
import type { Mock } from "vitest";
import type { Circle } from "~/lib/data.js";
import type { EntityDouble } from "./contract.js";
import { testId } from "./ids.js";

export interface CirclesState {
  /** `listMyCircles` — `undefined` ≡ loading. */
  circles?: Circle[] | null;
  /** `getCircle` (the Circle guard's by-id subscription) — `undefined` ≡ loading,
   * `null` ≡ inaccessible/missing (ADR 0016). Lets a test drive the REAL Circle
   * layout (its `useResolvedCircle`) rather than only the Outlet-context bypass. */
  circle?: Circle | null;
  /** The `createCircle` mutation spy the test owns (CS-0). Returns the new Circle's id,
   * so a test configures `vi.fn().mockResolvedValue(testId("c-new"))` to drive the
   * create flow's navigation to the canonical ref. */
  createCircle?: Mock;
  completeCircleSetup?: Mock;
  renameCircle?: Mock;
  setCurrency?: Mock;
  updateCircleSettings?: Mock;
  setPersonalCircleNameAutoSync?: Mock;
  archiveCircle?: Mock;
  restoreCircle?: Mock;
  circleHasTransactions?: boolean | null;
  deleteCircle?: Mock;
}

export function circlesDouble(state: CirclesState): EntityDouble {
  const {
    circles,
    circle,
    createCircle,
    completeCircleSetup,
    renameCircle,
    setCurrency,
    updateCircleSettings,
    setPersonalCircleNameAutoSync,
    archiveCircle,
    restoreCircle,
    circleHasTransactions,
    deleteCircle,
  } = state;
  return {
    queries: {
      [getFunctionName(api.circles.listMyCircles)]: () => circles,
      [getFunctionName(api.circles.getCircle)]: () => circle,
      [getFunctionName(api.circles.circleHasTransactions)]: () => circleHasTransactions ?? false,
    },
    mutations: {
      [getFunctionName(api.circles.createCircle)]: createCircle,
      [getFunctionName(api.circles.completeCircleSetup)]: completeCircleSetup,
      [getFunctionName(api.circles.renameCircle)]: renameCircle,
      [getFunctionName(api.circles.setCurrency)]: setCurrency,
      [getFunctionName(api.circles.updateCircleSettings)]: updateCircleSettings,
      [getFunctionName(api.circles.setPersonalCircleNameAutoSync)]: setPersonalCircleNameAutoSync,
      [getFunctionName(api.circles.archiveCircle)]: archiveCircle,
      [getFunctionName(api.circles.restoreCircle)]: restoreCircle,
      [getFunctionName(api.circles.deleteCircle)]: deleteCircle,
    },
  };
}

/** Default `Circle` fixture for shell and Circle-scoped route tests. */
export function makeCircleView(over: Partial<Circle> = {}): Circle {
  return {
    id: testId<Circle["id"]>("c1"),
    ref: "trip-c1",
    name: "Trip",
    kind: "regular",
    currency: "USD",
    color: "blue",
    mark: "T",
    status: "active",
    setupAnswers: undefined,
    setupComplete: true,
    currencyLocked: false,
    nameCustomized: false,
    ...over,
  };
}
