import { Menu } from "@base-ui/react/menu";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { usePwaInstall } from "~/components/pwa-install.js";
import { Avatar } from "~/components/ui/avatar.js";
import { Badge } from "~/components/ui/badge.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import { signOut } from "~/lib/auth-client.js";
import { isCircleScopedPath } from "~/lib/circle-path.js";
import { useReturnToOrigin, withReturnTo } from "~/lib/return-to-url.js";
import type { SessionUser } from "~/lib/session.js";
import { cn } from "~/lib/utils.js";

const menuItemClass =
  "flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground outline-none select-none data-disabled:cursor-default data-disabled:opacity-70 data-highlighted:bg-muted/60";

/**
 * Single-slot “New” affordance for one account-menu link at a time.
 * Move this element when another feature should own the badge; never mount twice.
 * Guarded by the at-most-one mount test in `account-menu.test.tsx`.
 */
function AccountMenuNewBadge() {
  return <Badge variant="soft">New</Badge>;
}

/**
 * Header account control: avatar trigger opens a Base UI `Menu` with identity,
 * Settings, Connections, What's new, conditional Install PocketCircle (#262), Send feedback, and optional
 * Sign out (ADR 0019 / issue #124). Send feedback is always the global route;
 * Circle-scoped origins only carry `returnTo` so Back can restore them. Circle
 * chrome owns contextual Feedback.
 */
export function AccountMenu({ user, showSignOut }: { user: SessionUser; showSignOut: boolean }) {
  const navigate = useNavigate();
  const origin = useReturnToOrigin();
  const { available: installAvailable, install } = usePwaInstall();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const feedbackTo = isCircleScopedPath(origin) ? withReturnTo("/feedback", origin) : "/feedback";

  // Sign-out is terminal: success lets the reactive ProtectedLayout guard redirect to
  // /signin once the session clears (no bespoke routing here), while a failed request
  // leaves the session intact, so we log it and send the user to that same /signin
  // destination ourselves rather than strand them in a half-signed-out menu (#132, #107).
  // Either outcome unmounts this control, so the pending state never needs resetting and
  // the re-entry guard blocks a double-click while the request is in flight.
  const handleSignOut = async () => {
    if (isSigningOut) {
      return;
    }
    setIsSigningOut(true);
    try {
      await signOut();
    } catch (error) {
      console.error("signOut failed", error);
      void navigate("/signin", { replace: true });
    }
  };

  return (
    <Menu.Root modal={false}>
      <Menu.Trigger
        aria-label="Account menu"
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon-xs" }),
          "size-10 shrink-0 rounded-full p-0 focus-visible:ring-offset-background",
        )}
      >
        <Avatar name={user.displayName} image={user.image} className="size-9" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Menu.Popup
            className={cn(
              "min-w-[220px] origin-(--transform-origin) animate-pop-in rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-xl outline-none",
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
              {/* TODO(account-menu-new-badge): Remove AccountMenuNewBadge when the next
                  feature claims this slot. At most one mount — see
                  account-menu.test.tsx. */}
              Connections
              <AccountMenuNewBadge />
            </Menu.LinkItem>
            <Menu.LinkItem
              className={menuItemClass}
              closeOnClick
              render={<Link to="/whats-new" prefetch="intent" />}
            >
              What's new
            </Menu.LinkItem>
            {installAvailable ? (
              <Menu.Item className={menuItemClass} closeOnClick onClick={() => install()}>
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
