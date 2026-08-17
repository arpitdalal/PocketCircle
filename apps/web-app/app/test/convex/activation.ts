import { api } from "@pocketcircle/convex";
import { getFunctionName } from "convex/server";
import type { Mock } from "vitest";
import type { ActivationChecklist, ReadyActivationChecklist } from "~/lib/data/activation.js";
import type { EntityDouble } from "./contract.js";
import { resolveWith } from "./contract.js";
import { testId } from "./ids.js";

export interface ActivationState {
  /** `getActivationChecklist` — `undefined` ≡ loading. */
  activation?:
    | ActivationChecklist
    | ((args: Record<string, unknown>) => ActivationChecklist | undefined);
  initializeActivationChecklist?: Mock;
  skipActivationChecklist?: Mock;
  acknowledgeActivationCompleted?: Mock;
}

export function activationDouble(state: ActivationState): EntityDouble {
  const {
    activation,
    initializeActivationChecklist,
    skipActivationChecklist,
    acknowledgeActivationCompleted,
  } = state;
  return {
    queries: {
      [getFunctionName(api.activation.getActivationChecklist)]: (args) =>
        resolveWith(activation, args),
    },
    mutations: {
      [getFunctionName(api.activation.initializeActivationChecklist)]:
        initializeActivationChecklist,
      [getFunctionName(api.activation.skipActivationChecklist)]: skipActivationChecklist,
      [getFunctionName(api.activation.acknowledgeActivationCompleted)]:
        acknowledgeActivationCompleted,
    },
  };
}

export function makeEligibleCircle(
  over: Partial<ReadyActivationChecklist["eligibleCircles"][number]> = {},
) {
  return {
    id: testId("c1"),
    ref: "personal-c1",
    name: "Personal",
    currency: "USD",
    kind: "personal" as const,
    ...over,
  } satisfies ReadyActivationChecklist["eligibleCircles"][number];
}

export function makeActivationChecklistView(over: Partial<ReadyActivationChecklist> = {}) {
  return {
    status: "ready" as const,
    visible: true,
    dismissed: false,
    allComplete: false,
    completedCount: 0,
    total: 4 as const,
    transactionComplete: false,
    categoryComplete: false,
    regularCircleComplete: false,
    sharedMemberState: "not_started" as const,
    pendingInvitationExpiresAt: null,
    firstIncomplete: "transaction" as const,
    memberCta: { kind: "create" } as const,
    completionEventPending: false,
    eligibleCircles: [makeEligibleCircle()],
    ...over,
  } satisfies ReadyActivationChecklist;
}
