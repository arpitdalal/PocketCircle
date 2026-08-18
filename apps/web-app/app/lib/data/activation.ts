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
 * Home Summary Activation Checklist subscription. Skip with `enabled=false` (unused
 * on Circle Dashboards). Existing Users with no row get the evidence initializer;
 * completion analytics are claimed once via the durable marker even after the card hides.
 */
export function useActivationChecklist(enabled: boolean) {
  const checklist = useQuery(
    api.activation.getActivationChecklist,
    enabled && !MOCKS ? {} : "skip",
  );
  const initialize = useMutation(api.activation.initializeActivationChecklist);
  const acknowledge = useMutation(api.activation.acknowledgeActivationCompleted);

  useEffect(() => {
    if (!enabled || MOCKS) {
      return;
    }
    if (checklist?.status === "uninitialized") {
      void initialize({});
    }
  }, [enabled, checklist, initialize]);

  useEffect(() => {
    if (!enabled || MOCKS) {
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
  }, [enabled, checklist, acknowledge]);

  if (MOCKS) {
    return enabled ? MOCK_ACTIVATION : undefined;
  }
  return checklist;
}

export function useSkipActivationChecklist() {
  return useMutation(api.activation.skipActivationChecklist);
}
