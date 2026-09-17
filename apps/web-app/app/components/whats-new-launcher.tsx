import { Sparkles } from "lucide-react";
import { useId, useState } from "react";
import { href, Link } from "react-router";
import { NEW_TAB_LINK_PROPS, NewTabCue } from "~/components/new-tab-link.js";
import { SidebarFlyout } from "~/components/sidebar-flyout.js";
import { Badge } from "~/components/ui/badge.js";
import { PopoverDescription, PopoverTitle, PopoverTrigger } from "~/components/ui/popover.js";
import { SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem } from "~/components/ui/sidebar.js";
import { track } from "~/lib/analytics.js";
import { useCloseWhenChromeHidden } from "~/lib/app-chrome.js";
import { changelogSource, parseChangelog } from "~/lib/changelog.js";
import { markChangelogVersionSeen, useChangelogUnread } from "~/lib/changelog-seen.js";

const TITLE = "What's new";

/** How many released sections and bullets-per-section the condensed feed previews. */
const PREVIEW_SECTION_COUNT = 3;
const PREVIEW_BULLET_COUNT = 3;

// Parsed once at module scope from the SAME source the public archive reads, so the
// preview can never become a second changelog catalog. `Unreleased` is already
// excluded by the parser.
const sections = parseChangelog(changelogSource);
const previewSections = sections.slice(0, PREVIEW_SECTION_COUNT);
const latestVersion = sections[0]?.version;

/** Category bullets flattened in authoring order — the preview drops the headings. */
function previewBullets(section: (typeof sections)[number]) {
  return section.categories.flatMap((category) => category.items).slice(0, PREVIEW_BULLET_COUNT);
}

/**
 * Desktop "What's new" launcher (issue #351): a quiet unread indicator plus a
 * condensed feed of the latest released sections, so a User can inspect recent
 * changes without leaving the current task. The full `/whats-new` archive stays
 * unchanged and opens in a new tab.
 */
export function WhatsNewLauncher({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const unread = useChangelogUnread(userId, latestVersion);
  useCloseWhenChromeHidden("sidebar", () => setOpen(false));
  // Opening marks the version seen, which clears `unread` immediately. Latch the
  // state AT OPEN so the "New" badge is still shown in the feed being read.
  const [unreadWhenOpened, setUnreadWhenOpened] = useState(false);
  const unreadId = useId();

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next || latestVersion === undefined) {
      return;
    }
    setUnreadWhenOpened(unread);
    markChangelogVersionSeen(userId, latestVersion);
    track("whats_new_opened", { latestVersion });
  };

  return (
    <SidebarMenuItem>
      <SidebarFlyout
        open={open}
        onOpenChange={handleOpenChange}
        trigger={
          <PopoverTrigger
            aria-describedby={unread ? unreadId : undefined}
            render={
              <SidebarMenuButton>
                <Sparkles aria-hidden />
                <span>{TITLE}</span>
              </SidebarMenuButton>
            }
          />
        }
        header={
          <>
            <PopoverTitle>{TITLE}</PopoverTitle>
            <PopoverDescription className="mt-0.5">
              The latest released updates to PocketCircle.
            </PopoverDescription>
          </>
        }
        footer={
          <Link
            {...NEW_TAB_LINK_PROPS}
            to={href("/whats-new")}
            className="flex items-center gap-1.5 rounded-md py-1 text-sm text-foreground underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            View all updates
            <NewTabCue />
          </Link>
        }
      >
        {previewSections.length === 0 ? (
          <p className="text-sm text-muted-foreground">No released updates yet.</p>
        ) : (
          <ul className="space-y-4">
            {previewSections.map((section, index) => {
              const bullets = previewBullets(section);
              return (
                <li key={section.version} className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium text-foreground">{section.version}</h3>
                    <span className="text-xs text-muted-foreground">{section.date}</span>
                    {index === 0 && unreadWhenOpened ? <Badge variant="soft">New</Badge> : null}
                  </div>
                  {section.intro[0] ? (
                    <p className="text-sm text-muted-foreground">{section.intro[0]}</p>
                  ) : null}
                  {bullets.length > 0 ? (
                    <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                      {bullets.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </SidebarFlyout>
      {/* "New" alone describes the row as "What's new … New". The badge stays short on
          screen and spells the state out for the description. */}
      {unread ? (
        <SidebarMenuBadge id={unreadId}>
          <span aria-hidden>New</span>
          <span className="sr-only">Unread updates</span>
        </SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
  );
}
