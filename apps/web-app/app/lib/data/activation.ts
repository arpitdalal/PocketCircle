import { api } from "@pocketcircle/convex";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect } from "react";
import { track } from "../analytics.js";
import { MOCKS } from "../env.js";

/**
 * UI-ready Activation Checklist contract (ADR 0030), derived from the Convex
 * query so it cannot drift from the backend. `uninitialized` means the existing-User
 * evidence path has not run yet — hide the card and initialize.
 */
export type ActivationChecklist = FunctionReturnType<typeof api.activation.getActivationChecklist>;
export type ReadyActivationChecklist = Extract<ActivationChecklist, { status: "ready" }>;

export const MOCK_ACTIVATION: ActivationChecklist = {
  status: "ready",
  visible: true,
  dismissed: false,
  allComplete: false,
  completedCount: 0,
  total: 4,
  transactionComplete: false,
  categoryComplete: false,
  regularCircleComplete: false,
  sharedMemberState: "not_started",
  pendingInvitationExpiresAt: null,
  firstIncomplete: "transaction",
  memberCta: { kind: "create" },
  completionEventPending: false,
  eligibleCircles: [],
};

/**
 * Activation Checklist subscription, plus the two side effects that ride with it:
 * existing Users with no row get the evidence initializer, and completion analytics are
 * claimed once via the durable marker even after the checklist hides.
 *
 * Those effects are why the authenticated shell mounts exactly ONE subscriber
 * (`ActivationChecklistProvider`) and both presentations read the value from it — two
 * callers would fire each mutation twice and lean on backend idempotence to clean up.
 */
export function useActivationChecklist() {
  const checklist = useQuery(api.activation.getActivationChecklist, MOCKS ? "skip" : {});
  const initialize = useMutation(api.activation.initializeActivationChecklist);
  const acknowledge = useMutation(api.activation.acknowledgeActivationCompleted);

  useEffect(() => {
    if (MOCKS) {
      return;
    }
    if (checklist?.status === "uninitialized") {
      void initialize({});
    }
  }, [checklist, initialize]);

  useEffect(() => {
    if (MOCKS) {
      return;
    }
    if (checklist?.status !== "ready" || !checklist.completionEventPending) {
      return;
    }
    void acknowledge({})
      .then((result) => {
        if (result.claimed) {
          track("activation_checklist_completed", {});
        }
      })
      .catch(() => {
        // Completion analytics are best-effort; do not surface failures to the User.
      });
  }, [checklist, acknowledge]);

  if (MOCKS) {
    return MOCK_ACTIVATION;
  }
  return checklist;
}

export function useSkipActivationChecklist() {
  return useMutation(api.activation.skipActivationChecklist);
}
