import { api } from "@pocketcircle/convex";
import { useMutation } from "convex/react";

export function useSubmitFeedback() {
  return useMutation(api.feedback.submitFeedback);
}
