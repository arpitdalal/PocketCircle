import { screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { Route } from "react-router";
import { AccountMenu } from "~/components/account-menu.js";
import { PwaInstallHeaderButton } from "~/components/pwa-install.js";
import type { AppChrome } from "~/lib/app-chrome.js";
import type { SessionUser } from "~/lib/session.js";
import { renderRoutes } from "./convex/render.js";

/**
 * Rendering the account menu and reading its items, shared by every file that asserts on
 * that menu (`account-menu.test.tsx`, `pwa-install.test.tsx`) so the trigger name, the
 * render wiring, and label normalization live in one place.
 *
 * Not re-exported from `~/test/convex-react.js`: it imports app components, which import
 * `convex/react`, which test files replace with a factory importing that same barrel.
 */

export const accountMenuTestUser: SessionUser = {
  id: "u1",
  email: "alex@example.com",
  displayName: "Alex Tester",
  image: undefined,
  onboardingComplete: true,
  analyticsEnabled: false,
  createdAt: 1,
  acknowledgedFeatureAnnouncementIds: [],
};

/**
 * Mounts the menu at `path` under a real router.
 *
 * - `chrome`: which shell hosts it — the header's avatar trigger or the sidebar row.
 * - `installShortcut`: also mount the header install button, for the PWA install cases
 *   where both surfaces react to the same eligibility.
 * - `routes`: destination routes a menu item navigates to.
 */
export function renderAccountMenu({
  chrome = "header",
  showSignOut = true,
  user = accountMenuTestUser,
  path = "/",
  initialEntries = ["/"],
  installShortcut = false,
  routes,
}: {
  chrome?: AppChrome;
  showSignOut?: boolean;
  user?: SessionUser;
  path?: string;
  initialEntries?: string[];
  installShortcut?: boolean;
  routes?: ReactNode;
} = {}) {
  return renderRoutes(
    <>
      <Route
        path={path}
        element={
          <>
            {installShortcut ? <PwaInstallHeaderButton /> : null}
            <AccountMenu chrome={chrome} user={user} showSignOut={showSignOut} />
          </>
        }
      />
      {routes}
    </>,
    { initialEntries },
  );
}

export async function openAccountMenu(u: UserEvent) {
  // Suffix match: the sidebar presentation leads with the Display Name (issue #351).
  await u.click(screen.getByRole("button", { name: /account menu$/i }));
}

/**
 * Menu item labels in DOM order, whitespace-normalized. Items may carry extra spoken
 * text — a `New` badge, or the new-tab cue on `What's new` — so labels are compared as
 * the reader hears them instead of as raw `textContent`.
 */
export async function accountMenuItemLabels() {
  const items = await screen.findAllByRole("menuitem");
  return items.map((item) => (item.textContent ?? "").replace(/\s+/g, " ").trim());
}
