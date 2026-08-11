import { api } from "@spend-circle/convex";
import { getFunctionName } from "convex/server";
import type { Mock } from "vitest";
import type { CurrentUser } from "~/lib/data/users.js";
import type { EntityDouble } from "./contract.js";
import { resolveWith } from "./contract.js";
import { testId } from "./ids.js";

/** The fields the session model reads off `getCurrentUser` (see `lib/session.ts`).
 * Kept to exactly that surface so the double models the contract the app consumes. */
export type CurrentUserView = CurrentUser;

export interface UsersState {
  /** `getCurrentUser` — `undefined` ≡ auth/user still loading, `null` ≡ authenticated
   * but no Spend Circle User yet (bootstrap), an object ≡ a bootstrapped User (ready).
   * A resolver re-reads on each subscription tick (models Convex reactivity after mutations). */
  currentUser?:
    | CurrentUserView
    | null
    | ((args: Record<string, unknown>) => CurrentUserView | null | undefined);
  completeOnboarding?: Mock;
  updateProfile?: Mock;
  setAnalyticsEnabled?: Mock;
}

export function usersDouble(state: UsersState): EntityDouble {
  const { currentUser, completeOnboarding, updateProfile, setAnalyticsEnabled } = state;
  return {
    queries: {
      [getFunctionName(api.users.getCurrentUser)]: (args) => resolveWith(currentUser, args),
    },
    mutations: {
      ...(completeOnboarding
        ? { [getFunctionName(api.users.completeOnboarding)]: completeOnboarding }
        : {}),
      ...(updateProfile ? { [getFunctionName(api.users.updateProfile)]: updateProfile } : {}),
      ...(setAnalyticsEnabled
        ? { [getFunctionName(api.users.setAnalyticsEnabled)]: setAnalyticsEnabled }
        : {}),
    },
  };
}

/** Default ready-User fixture for shell tests. */
export function makeCurrentUserView(over: Partial<CurrentUserView> = {}): CurrentUserView {
  return {
    id: testId<CurrentUser["id"]>("user-self"),
    email: "you@example.com",
    displayName: "You",
    image: undefined,
    onboardingComplete: true,
    analyticsEnabled: false,
    ...over,
  };
}
