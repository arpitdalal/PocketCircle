import type { ReactNode } from "react";
import { Route } from "react-router";
import { ActivationChecklistProvider } from "~/components/activation-checklist-provider.js";
import { SidebarMenu, SidebarProvider } from "~/components/ui/sidebar.js";
import { renderRoutes } from "./convex/render.js";

/**
 * Render wiring for the two Activation Checklist presentations and the sidebar rows that
 * sit beside them.
 *
 * Deliberately NOT re-exported from `~/test/convex-react.js`: these helpers import app
 * components, and those components import `convex/react`, which test files replace with a
 * factory that imports that same barrel. Going through the barrel would deadlock the
 * module graph, so test files import this module directly.
 */

/**
 * Wraps a checklist presentation in the shell's single subscriber, the way
 * `ProtectedLayout` does — the Home card and the sidebar launcher both read its value.
 */
export function withActivationChecklist(node: ReactNode) {
  return <ActivationChecklistProvider>{node}</ActivationChecklistProvider>;
}

/**
 * Renders one sidebar row in the chrome it ships in: the sidebar provider, a real
 * `SidebarMenu` list, and the shell's checklist subscriber. Extra `routes` let a test
 * assert where a row's link goes.
 */
export function renderSidebarRow(
  row: ReactNode,
  opts: { initialEntries?: string[]; routes?: ReactNode } = {},
) {
  return renderRoutes(
    <>
      <Route
        path="/"
        element={withActivationChecklist(
          <SidebarProvider>
            <SidebarMenu>{row}</SidebarMenu>
          </SidebarProvider>,
        )}
      />
      {opts.routes}
    </>,
    { initialEntries: opts.initialEntries },
  );
}
