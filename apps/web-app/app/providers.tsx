import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import type { ReactNode } from "react";
import { PwaInstallProvider } from "./components/pwa-install.js";
import { SignInHandoffNotice } from "./components/sign-in-handoff-notice.js";
import { authClient } from "./lib/auth-client.js";
import { convex } from "./lib/convex.js";
import { SnackbarProvider } from "./lib/snackbar.js";

/**
 * App-wide providers. Reactive auth flows through ConvexBetterAuthProvider so
 * auth state and live queries share one source of truth (ADR 0017).
 * PwaInstallProvider mounts above the route tree so installability events are
 * not missed while auth/session resolves (#262).
 * SignInHandoffNotice sits inside SnackbarProvider because that is where it reports:
 * the provider above redeems a cross-domain sign-in silently, and a handoff that never
 * completes is otherwise indistinguishable from a User who is simply signed out (#409).
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ConvexBetterAuthProvider client={convex} authClient={authClient}>
      <PwaInstallProvider>
        <SnackbarProvider>
          <SignInHandoffNotice />
          {children}
        </SnackbarProvider>
      </PwaInstallProvider>
    </ConvexBetterAuthProvider>
  );
}
