import { api } from "@pocketcircle/convex";
import { getFunctionName } from "convex/server";
import type { Mock } from "vitest";
import type { ActivationChecklist, ReadyActivationChecklist } from "~/lib/data/activation.js";
import type { EntityDouble } from "./contract.js";
import { resolveWith } from "./contract.js";

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

export function makeActivationChecklistView(
  over: Partial<ReadyActivationChecklist> = {},
): ReadyActivationChecklist {
  return {
    status: "ready",
    visible: true,
    dismissed: false,
    allComplete: false,
    completedCount: 0,
    total: 4,
    personalTransactionComplete: false,
    personalCategoryComplete: false,
    regularCircleComplete: false,
    sharedMemberState: "not_started",
    pendingInvitationExpiresAt: null,
    firstIncomplete: "personalTransaction",
    memberCta: { kind: "create" },
    completionEventPending: false,
    ...over,
  };
}
