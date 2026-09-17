import { House } from "lucide-react";
import { useId } from "react";
import { href, Link, matchPath, NavLink, useLocation } from "react-router";
import { AccountMenu } from "~/components/account-menu.js";
import { ActivationChecklistLauncher } from "~/components/activation-checklist-launcher.js";
import { BrandMark } from "~/components/brand-mark.js";
import { CircleSwitcher } from "~/components/circle-switcher.js";
import { NotificationCenter } from "~/components/notification-center.js";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "~/components/ui/sidebar.js";
import { WhatsNewLauncher } from "~/components/whats-new-launcher.js";
import { circleNavItems, isCircleNavItemActive } from "~/lib/circle-nav.js";
import { circleRefOf } from "~/lib/circle-path.js";
import type { SessionUser } from "~/lib/session.js";

/**
 * The persistent desktop app sidebar (issue #351), painted at `lg` and above in place
 * of the sticky header and the horizontal Circle tabs.
 *
 * It lives in the protected shell, ABOVE the Circle guard, so cross-Circle and shell
 * navigation never flash it out while route skeletons replace the outlet. Its Circle
 * group is therefore driven by the URL — `circleRefOf` for scope and `circleNavItems`
 * for the destinations — rather than by resolved Circle context, keeping the canonical
 * navigation model as the single source (no second route list).
 *
 * Because the panel sits above that guard, a Circle ref the guard is about to reject
 * (deleted Circle, revoked membership, typo) briefly paints its destinations while
 * `CircleLayout` resolves and redirects. Waiting for resolution instead would flash the
 * whole group out on every cross-Circle navigation, which is the failure the URL-driven
 * model exists to avoid; clicking one of those rows only re-enters the same redirect.
 */
export function AppSidebar({ user, showSignOut }: { user: SessionUser; showSignOut: boolean }) {
  const location = useLocation();
  const circleRef = circleRefOf(location.pathname);
  const homeActive = matchPath({ path: href("/"), end: true }, location.pathname) !== null;

  return (
    <Sidebar aria-label="PocketCircle">
      <SidebarHeader>
        {/* Brand and bell share the top row. The brand shrinks and truncates while the
            bell keeps its hit area, so a narrower panel (or a longer brand) can never
            push the notification trigger out of the sidebar. */}
        <div className="flex items-center gap-1">
          <Link
            to={href("/")}
            prefetch="intent"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 font-display text-base font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          >
            <BrandMark />
            <span className="truncate">PocketCircle</span>
          </Link>
          <NotificationCenter chrome="sidebar" />
        </div>
        <CircleSwitcher chrome="sidebar" className="w-full justify-between" />
      </SidebarHeader>

      <SidebarContent>
        <nav aria-label="Primary">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    isActive={homeActive}
                    render={<NavLink to={href("/")} end prefetch="intent" />}
                  >
                    <House aria-hidden />
                    <span>Home</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {circleRef === null ? null : (
            <CircleNavGroup circleRef={circleRef} pathname={location.pathname} />
          )}
        </nav>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <ActivationChecklistLauncher />
          <WhatsNewLauncher userId={user.id} />
          {/* No separate install shortcut here: the account menu already carries
              "Install PocketCircle" whenever the app is installable (issue #262), so the
              panel spends its rows on destinations instead of a duplicate trigger. */}
          <SidebarMenuItem>
            <AccountMenu chrome="sidebar" user={user} showSignOut={showSignOut} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

/**
 * The active Circle's destinations. Active state comes from `isCircleNavItemActive`
 * (React Router's own `matchPath` with each item's `end`), the same matcher the mobile
 * bottom bar uses, so nested detail routes light up the correct parent item; `NavLink`
 * still contributes `aria-current`.
 */
function CircleNavGroup({ circleRef, pathname }: { circleRef: string; pathname: string }) {
  const labelId = useId();

  return (
    <SidebarGroup role="group" aria-labelledby={labelId}>
      <SidebarGroupLabel id={labelId}>Circle</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {circleNavItems(circleRef).map((item) => {
            const Icon = item.icon;
            return (
              <SidebarMenuItem key={item.to}>
                <SidebarMenuButton
                  isActive={isCircleNavItemActive(pathname, item)}
                  render={<NavLink to={item.to} end={item.end} prefetch="intent" />}
                >
                  <Icon aria-hidden />
                  <span>{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
