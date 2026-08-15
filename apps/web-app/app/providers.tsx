import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import type { ReactNode } from "react";
import { PwaInstallProvider } from "./components/pwa-install.js";
import { authClient } from "./lib/auth-client.js";
import { convex } from "./lib/convex.js";
import { SnackbarProvider } from "./lib/snackbar.js";

/**
 * App-wide providers. Reactive auth flows through ConvexBetterAuthProvider so
 * auth state and live queries share one source of truth (ADR 0017).
 * PwaInstallProvider mounts above the route tree so installability events are
 * not missed while auth/session resolves (#262).
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ConvexBetterAuthProvider client={convex} authClient={authClient}>
      <PwaInstallProvider>
        <SnackbarProvider>{children}</SnackbarProvider>
      </PwaInstallProvider>
    </ConvexBetterAuthProvider>
  );
}
