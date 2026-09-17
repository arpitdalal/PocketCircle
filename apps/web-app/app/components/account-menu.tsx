import { Menu } from "@base-ui/react/menu";
import { ChevronsUpDown, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { NEW_TAB_LINK_PROPS, NewTabCue } from "~/components/new-tab-link.js";
import { usePwaInstall } from "~/components/pwa-install.js";
import { Avatar } from "~/components/ui/avatar.js";
import { Badge } from "~/components/ui/badge.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import { SidebarMenuButton } from "~/components/ui/sidebar.js";
import { type AppChrome, chromeMenuPlacement, useCloseWhenChromeHidden } from "~/lib/app-chrome.js";
import { signOut } from "~/lib/auth-client.js";
import { isCircleScopedPath } from "~/lib/circle-path.js";
import { useClearPushOnSignOut } from "~/lib/data.js";
import { useReturnToOrigin, withReturnTo } from "~/lib/return-to-url.js";
import type { SessionUser } from "~/lib/session.js";
import { cn } from "~/lib/utils.js";

const menuItemClass =
  "flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground outline-none select-none data-disabled:cursor-default data-disabled:opacity-70 data-highlighted:bg-muted/60";

type AccountMenuItemId = "settings" | "connections" | "whats-new" | "feedback" | "install";

/**
 * Single-slot “New” owner in the account menu. Flip this when another item
 * should own the badge; never set more than one owner. Menu items call
 * `accountMenuNewBadge` so ownership stays in one place.
 */
const ACCOUNT_MENU_NEW_FOR: AccountMenuItemId = "connections";

function accountMenuNewBadge(item: AccountMenuItemId) {
  if (item !== ACCOUNT_MENU_NEW_FOR) {
    return null;
  }
  return (
    <Badge variant="soft" data-account-menu-new="true">
      New
    </Badge>
  );
}

/**
 * Shell account control: avatar trigger opens a Base UI `Menu` with identity,
 * Settings, Connections, What's new, conditional Install PocketCircle (#262), Send feedback, and optional
 * Sign out (ADR 0019 / issue #124). Send feedback is always the global route;
 * Circle-scoped origins only carry `returnTo` so Back can restore them. Circle
 * chrome owns contextual Feedback.
 *
 * `chrome` picks the trigger presentation and the menu's placement (issue #351): the
 * header keeps an avatar-only round button and hangs the menu below the bar, the
 * desktop sidebar shows a full-width row naming the signed-in User and sends the menu
 * out to the side. The email stays in the menu, where it identifies the account
 * without repeating itself in the persistent chrome.
 */
export function AccountMenu({
  user,
  showSignOut,
  chrome,
}: {
  user: SessionUser;
  showSignOut: boolean;
  chrome: AppChrome;
}) {
  const navigate = useNavigate();
  const origin = useReturnToOrigin();
  const { available: installAvailable, install } = usePwaInstall();
  const clearPushOnSignOut = useClearPushOnSignOut();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const feedbackTo = isCircleScopedPath(origin) ? withReturnTo("/feedback", origin) : "/feedback";

  useCloseWhenChromeHidden(chrome, () => setMenuOpen(false));

  // Sign-out is terminal: success lets the reactive ProtectedLayout guard redirect to
  // /signin once the session clears (no bespoke routing here), while a failed request
  // leaves the session intact, so we log it and send the user to that same /signin
  // destination ourselves rather than strand them in a half-signed-out menu (#132, #107).
  // Either outcome unmounts this control, so the pending state never needs resetting and
  // the re-entry guard blocks a double-click while the request is in flight.
  // Clear local Push + User binding before signOut (#381); failures must not block.
  // Keep enable-cancel until signOut settles so another tab cannot bind mid-logout.
  const handleSignOut = async () => {
    if (isSigningOut) {
      return;
    }
    setIsSigningOut(true);
    let releasePushSignOutGuard = () => {};
    try {
      releasePushSignOutGuard = await clearPushOnSignOut();
    } catch (error) {
      // clearLocal… never rejects by contract; keep UI resilient if that regresses.
      console.error("signOut push cleanup failed", error);
    }
    try {
      await signOut().finally(releasePushSignOutGuard);
    } catch (error) {
      console.error("signOut failed", error);
      void navigate("/signin", { replace: true });
    }
  };

  return (
    <Menu.Root modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
      {chrome === "sidebar" ? (
        // Display Name first in the accessible name so speech input can say what it
        // sees (WCAG 2.5.3); the Avatar itself is decorative and stays silent.
        <Menu.Trigger
          aria-label={`${user.displayName}, account menu`}
          render={<SidebarMenuButton size="lg" />}
        >
          <Avatar name={user.displayName} image={user.image} className="size-8" />
          <span className="min-w-0 flex-1 truncate font-medium">{user.displayName}</span>
          <ChevronsUpDown aria-hidden className="text-muted-foreground" />
        </Menu.Trigger>
      ) : (
        <Menu.Trigger
          aria-label="Account menu"
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon-xs" }),
            "size-10 shrink-0 rounded-full p-0 focus-visible:ring-offset-background",
          )}
        >
          <Avatar name={user.displayName} image={user.image} className="size-9" />
        </Menu.Trigger>
      )}
      <Menu.Portal>
        <Menu.Positioner {...chromeMenuPlacement(chrome, "end")} sideOffset={6} className="z-50">
          <Menu.Popup
            className={cn(
              "min-w-[220px] max-w-(--available-width) origin-(--transform-origin) animate-pop-in rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-xl outline-none",
            )}
          >
            <div className="border-b border-border px-3 py-2">
              <p className="text-sm font-medium text-foreground">{user.displayName}</p>
              <p className="text-xs text-muted-foreground">{user.email}</p>
            </div>
            <Menu.LinkItem
              className={menuItemClass}
              closeOnClick
              render={<Link to="/settings" prefetch="intent" />}
            >
              Settings
            </Menu.LinkItem>
            <Menu.LinkItem
              className={`${menuItemClass} justify-between`}
              closeOnClick
              render={<Link to="/connections" prefetch="intent" />}
            >
              {/* TODO(account-menu-new-badge): Flip ACCOUNT_MENU_NEW_FOR when another
                  feature claims this slot. */}
              Connections
              {accountMenuNewBadge("connections")}
            </Menu.LinkItem>
            {/* New tab (issue #351): closing the archive returns the User to the
                unchanged app page they were on. Same contract as the desktop
                sidebar's "View all updates". */}
            <Menu.LinkItem
              className={`${menuItemClass} justify-between`}
              closeOnClick
              render={<Link {...NEW_TAB_LINK_PROPS} to="/whats-new" />}
            >
              What's new
              <NewTabCue />
            </Menu.LinkItem>
            {installAvailable ? (
              <Menu.Item className={menuItemClass} onClick={() => install()}>
                Install PocketCircle
              </Menu.Item>
            ) : null}
            <Menu.LinkItem
              className={menuItemClass}
              closeOnClick
              render={<Link to={feedbackTo} prefetch="intent" />}
            >
              Send feedback
            </Menu.LinkItem>
            {showSignOut ? (
              <Menu.Item
                className={menuItemClass}
                closeOnClick={false}
                disabled={isSigningOut}
                aria-busy={isSigningOut}
                onClick={() => void handleSignOut()}
              >
                {isSigningOut ? (
                  <>
                    <LoaderCircle aria-hidden className="size-4 animate-spin" />
                    Signing out...
                  </>
                ) : (
                  "Sign out"
                )}
              </Menu.Item>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
