import { api } from "@spend-circle/convex";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";

/**
 * The single current-user view contract, derived from the Convex function's return
 * type so it cannot drift from the backend (ADR 0003).
 */
export type CurrentUser = NonNullable<FunctionReturnType<typeof api.users.getCurrentUser>>;

export function useCompleteOnboarding() {
  return useMutation(api.users.completeOnboarding);
}

export function useUpdateProfile() {
  return useMutation(api.users.updateProfile);
}

export function useSetAnalyticsEnabled() {
  return useMutation(api.users.setAnalyticsEnabled);
}
