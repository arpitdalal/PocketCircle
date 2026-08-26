import { api } from "@pocketcircle/convex";
import { useConvexAuth, useQuery } from "convex/react";
import { MOCKS } from "./env.js";

/**
 * The four-state auth model the protected layout gates on (ADR 0017):
 *  - loading: auth is still resolving → show splash
 *  - unauthenticated: no Google session → redirect to /signin
 *  - bootstrap: Google session exists but no PocketCircle User yet → bootstrap splash
 *  - ready: bootstrapped User → render the app shell (may still need product Onboarding)
 */
export type AppSession =
  | { state: "loading" }
  | { state: "unauthenticated" }
  | { state: "bootstrap" }
  | { state: "ready"; user: SessionUser };

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  image?: string;
  onboardingComplete: boolean;
  analyticsEnabled: boolean;
  createdAt: number;
  acknowledgedFeatureAnnouncementIds: string[];
}

function useRealSession(): AppSession {
  const { isLoading, isAuthenticated } = useConvexAuth();
  // Only subscribe to the User once authenticated; `"skip"` avoids an
  // unauthenticated query that would always error.
  const user = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : "skip");

  if (isLoading) {
    return { state: "loading" };
  }
  if (!isAuthenticated) {
    return { state: "unauthenticated" };
  }
  if (user === undefined) {
    return { state: "loading" };
  }
  if (user === null) {
    return { state: "bootstrap" };
  }
  return {
    state: "ready",
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      image: user.image,
      onboardingComplete: user.onboardingComplete,
      analyticsEnabled: user.analyticsEnabled,
      createdAt: user.createdAt,
      acknowledgedFeatureAnnouncementIds: user.acknowledgedFeatureAnnouncementIds,
    },
  };
}

/**
 * Mock-mode session: the dev auth bypass injects a ready User without touching
 * Google or the backend, so Playwright never drives the OAuth flow (ADR 0006).
 */
function useMockSession(): AppSession {
  return {
    state: "ready",
    user: {
      id: "mock-user",
      email: "mock@pocketcircle.test",
      displayName: "Mock Member",
      onboardingComplete: true,
      analyticsEnabled: false,
      createdAt: 0,
      acknowledgedFeatureAnnouncementIds: [],
    },
  };
}

// Selected once at module load — MOCKS is a build-time constant, so the chosen
// hook is stable across renders and the production build drops the mock path.
export const useAppSession: () => AppSession = MOCKS ? useMockSession : useRealSession;
