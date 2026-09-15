import { Menu } from "@base-ui/react/menu";
import { Bell } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { InfiniteScrollFooter } from "~/components/infinite-scroll-footer.js";
import { Button } from "~/components/ui/button.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import { Segmented } from "~/components/ui/segmented.js";
import {
  type Notification,
  useMarkAllRead,
  useMarkNotificationRead,
  useNotifications,
  useUnreadCount,
} from "~/lib/data/notifications.js";
import { formatAuditTimestamp } from "~/lib/datetime.js";
import {
  clearNotificationCenterFocus,
  useNotificationCenterFocusId,
} from "~/lib/notification-center-focus.js";
import { cn } from "~/lib/utils.js";

const FILTER_OPTIONS = [
  { label: "Unread", value: "unread" },
  { label: "All", value: "all" },
] as const;

type NotificationFilter = (typeof FILTER_OPTIONS)[number]["value"];

const menuItemClass =
  "flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-3 py-2 text-left text-sm text-foreground outline-none select-none data-disabled:cursor-default data-disabled:opacity-70 data-highlighted:bg-muted/60";

function badgeLabel(count: number, hasMore: boolean) {
  if (hasMore) {
    return "99+ unread notifications";
  }
  if (count === 1) {
    return "1 unread notification";
  }
  return `${count} unread notifications`;
}

function NotificationRow({
  notification,
  onMarkRead,
  rowRef,
}: {
  notification: Notification;
  onMarkRead: (id: Notification["id"]) => void;
  rowRef?: (node: HTMLLIElement | null) => void;
}) {
  const timestamp = formatAuditTimestamp(notification.createdAt);
  const unread = !notification.read;
  const content = (
    <span className="flex items-start gap-2">
      <span
        aria-hidden
        className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", unread && "bg-primary")}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        {unread ? <span className="sr-only">Unread{"\u00a0"}</span> : null}
        <span className={unread ? "font-medium text-foreground" : undefined}>
          {notification.title}
        </span>
        {notification.body ? (
          <span className="text-xs text-muted-foreground">{notification.body}</span>
        ) : null}
        <span className="text-xs text-muted-foreground">{timestamp}</span>
      </span>
    </span>
  );

  const handleActivate = () => {
    if (unread) {
      void onMarkRead(notification.id);
    }
  };

  return (
    <li ref={rowRef} className="list-none" data-notification-id={notification.id}>
      {notification.link ? (
        <Menu.LinkItem
          className={menuItemClass}
          closeOnClick
          render={<Link to={notification.link} prefetch="intent" onClick={handleActivate} />}
        >
          {content}
        </Menu.LinkItem>
      ) : (
        <Menu.Item className={menuItemClass} closeOnClick={false} onClick={handleActivate}>
          {content}
        </Menu.Item>
      )}
    </li>
  );
}

/**
 * App-wide Notification Center: bell trigger, capped unread badge, Unread | All
 * filter, infinite-scroll tray, and mark-all-read of the click-time unread set.
 * Push clicks (#384) open All and scroll to the matching row when resolution
 * falls back to the tray.
 */
export function NotificationCenter() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [filter, setFilter] = useState<NotificationFilter>("unread");
  const listRef = useRef<HTMLUListElement>(null);
  const focusRowRef = useRef<HTMLLIElement | null>(null);
  const pushFocusId = useNotificationCenterFocusId();
  const [seenPushFocusId, setSeenPushFocusId] = useState<string | null>(null);

  // React-approved: adjust local UI state when an external Push focus id arrives.
  if (pushFocusId !== seenPushFocusId) {
    setSeenPushFocusId(pushFocusId);
    if (pushFocusId) {
      setFilter("all");
      setMenuOpen(true);
    }
  }

  const unreadOnly = filter === "unread";
  const { notifications, status, loadMore } = useNotifications(unreadOnly, menuOpen);
  const unread = useUnreadCount();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllRead();
  const [markingAll, setMarkingAll] = useState(false);

  const unreadCount = unread?.count ?? 0;
  const showBadge = unreadCount > 0 || unread?.hasMore;
  const showMarkAllRead = unreadCount > 0 || unread?.hasMore === true;
  const showEmpty = status !== "LoadingFirstPage" && notifications.length === 0;

  // DOM scroll + clear external store only — no React setState.
  useEffect(() => {
    if (!menuOpen || !pushFocusId || filter !== "all") {
      return;
    }
    const found = notifications.some((n) => n.id === pushFocusId);
    if (found) {
      focusRowRef.current?.scrollIntoView({ block: "nearest" });
      clearNotificationCenterFocus();
      return;
    }
    if (status === "CanLoadMore") {
      loadMore();
      return;
    }
    if (status === "Exhausted") {
      clearNotificationCenterFocus();
    }
  }, [menuOpen, pushFocusId, filter, notifications, status, loadMore]);

  const handleMarkRead = async (notificationId: Notification["id"]) => {
    try {
      await markRead({ notificationId });
    } catch {
      // Own notifications only; swallow so a mid-navigation failure cannot reject.
    }
  };

  const handleMarkAllRead = async () => {
    if (markingAll) {
      return;
    }
    setMarkingAll(true);
    try {
      await markAllRead({});
    } finally {
      setMarkingAll(false);
    }
  };

  const handleMenuOpenChange = (open: boolean) => {
    setMenuOpen(open);
    if (!open && pushFocusId) {
      clearNotificationCenterFocus();
    }
  };

  return (
    <Menu.Root modal={false} open={menuOpen} onOpenChange={handleMenuOpenChange}>
      <Menu.Trigger
        aria-label="Notifications"
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon-xs" }),
          "relative size-10 shrink-0 rounded-full focus-visible:ring-offset-background",
        )}
      >
        <Bell aria-hidden className="size-5" />
        {showBadge ? (
          <span
            className="absolute -top-0.5 -right-0.5 flex min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-5 text-primary-foreground"
            aria-live="polite"
          >
            <span className="sr-only">{badgeLabel(unreadCount, unread?.hasMore ?? false)}</span>
            <span aria-hidden>{unread?.hasMore ? "99+" : unreadCount}</span>
          </span>
        ) : null}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Menu.Popup
            className={cn(
              "flex max-h-[min(24rem,70dvh)] w-[min(22rem,calc(100vw-2rem))] origin-(--transform-origin) animate-pop-in flex-col rounded-lg border border-border bg-popover text-popover-foreground shadow-xl outline-none",
            )}
          >
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <p className="text-sm font-medium">Notifications</p>
              <Segmented
                compact
                label="Notification filter"
                value={filter}
                options={[...FILTER_OPTIONS]}
                onChange={setFilter}
              />
            </div>
            <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
              {showEmpty ? (
                <li className="list-none px-3 py-6 text-center text-sm text-muted-foreground">
                  {unreadOnly ? "You're all caught up" : "No notifications"}
                </li>
              ) : (
                notifications.map((notification) => (
                  <NotificationRow
                    key={notification.id}
                    notification={notification}
                    onMarkRead={handleMarkRead}
                    rowRef={
                      pushFocusId === notification.id
                        ? (node) => {
                            focusRowRef.current = node;
                          }
                        : undefined
                    }
                  />
                ))
              )}
              <li className="list-none">
                <InfiniteScrollFooter
                  status={status}
                  loadMore={loadMore}
                  loadingCopy="Loading more notifications…"
                  listAriaLabel="Notification list"
                  sentinelTestId="notifications-infinite-scroll-sentinel"
                  rootRef={listRef}
                />
              </li>
            </ul>
            {showMarkAllRead ? (
              <div className="border-t border-border px-3 py-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  disabled={markingAll}
                  aria-busy={markingAll}
                  onClick={() => void handleMarkAllRead()}
                >
                  Mark all read
                </Button>
              </div>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
