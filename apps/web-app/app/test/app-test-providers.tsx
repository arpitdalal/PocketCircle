import type { ReactNode } from "react";
import { PwaInstallProvider } from "~/components/pwa-install.js";
import { SnackbarProvider } from "~/lib/snackbar.js";

/**
 * Canonical app-shell providers for web tests (ADR 0006 / #262).
 * One composition for MemoryRouter helpers and createRoutesStub helpers so
 * Snackbar + PWA install wiring cannot drift.
 */
export function AppTestProviders({ children }: { children: ReactNode }) {
  return (
    <PwaInstallProvider>
      <SnackbarProvider>{children}</SnackbarProvider>
    </PwaInstallProvider>
  );
}
