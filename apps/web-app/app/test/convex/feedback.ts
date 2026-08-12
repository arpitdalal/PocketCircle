import { api } from "@pocketcircle/convex";
import { getFunctionName } from "convex/server";
import type { Mock } from "vitest";
import type { EntityDouble } from "./contract.js";

export interface FeedbackState {
  submitFeedback?: Mock;
}

export function feedbackDouble(state: FeedbackState): EntityDouble {
  const { submitFeedback } = state;
  return {
    mutations: {
      ...(submitFeedback ? { [getFunctionName(api.feedback.submitFeedback)]: submitFeedback } : {}),
    },
  };
}
