import { convexClient, crossDomainClient } from "@convex-dev/better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Better Auth React client wired to the Convex-hosted auth routes (ADR 0002).
 * Sign-in is Google-only; the production flow is never mocked (ADR 0006).
 *
 * The client plugins must mirror the server plugins (convex + crossDomain in
 * auth.ts): `crossDomainClient` owns the one-time-token exchange after the OAuth
 * redirect and stores/attaches the cross-origin session, since the app and the
 * *.convex.site auth deployment are different origins.
 */
export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_CONVEX_SITE_URL,
  plugins: [convexClient(), crossDomainClient()],
});

export async function signInWithGoogle(callbackURL = "/") {
  const result = await authClient.signIn.social({ provider: "google", callbackURL });

  if (result.error) {
    throw result.error;
  }
}

export async function signOut() {
  const result = await authClient.signOut();

  if (result.error) {
    throw result.error;
  }
}

/** Starts Better Auth's verified deletion flow (sends the verification email). */
export async function requestAccountDeletion() {
  const result = await authClient.deleteUser();

  if (result.error) {
    throw result.error;
  }
}

/** Completes Account Deletion with the emailed token (requires matching session). */
export async function confirmAccountDeletion(token: string) {
  const result = await authClient.deleteUser({ token });

  if (result.error) {
    throw result.error;
  }
}
