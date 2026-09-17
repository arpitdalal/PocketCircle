import { ListChecks } from "lucide-react";
import { useId, useState } from "react";
import {
  ACTIVATION_TITLE,
  ActivationChecklistHeader,
  ActivationChecklistItems,
  activationProgressText,
} from "~/components/activation-checklist-content.js";
import { useActivationChecklistValue } from "~/components/activation-checklist-provider.js";
import { SidebarFlyout } from "~/components/sidebar-flyout.js";
import { focusMainContent } from "~/components/skip-navigation.js";
import { PopoverDescription, PopoverTitle, PopoverTrigger } from "~/components/ui/popover.js";
import { SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem } from "~/components/ui/sidebar.js";
import { useCloseWhenChromeHidden } from "~/lib/app-chrome.js";

/**
 * Desktop presentation of the Activation Checklist (issue #351): a sidebar row that
 * opens the shared checklist in a flyout, so setup progress follows the User off Home
 * instead of living in the Home feed.
 *
 * Eligibility, items, CTAs, picker, and skip all come from the shared content; this
 * adds only the launcher and its open state. Nothing renders while the query is
 * loading or uninitialized, and a successful skip or completion removes the launcher
 * through the same reactive query the Home card uses.
 */
export function ActivationChecklistLauncher() {
  const checklist = useActivationChecklistValue();
  const [open, setOpen] = useState(false);
  const progressId = useId();

  useCloseWhenChromeHidden("sidebar", () => setOpen(false));

  if (checklist === undefined || checklist.status !== "ready" || !checklist.visible) {
    return null;
  }

  return (
    <SidebarMenuItem>
      <SidebarFlyout
        open={open}
        onOpenChange={setOpen}
        // The Category action can hand off to a modal Circle picker rendered by the
        // checklist content, which must outlive the flyout closing ahead of it.
        keepMounted
        trigger={
          <PopoverTrigger
            aria-describedby={progressId}
            render={
              <SidebarMenuButton>
                <ListChecks aria-hidden />
                <span>{ACTIVATION_TITLE}</span>
              </SidebarMenuButton>
            }
          />
        }
        header={
          <ActivationChecklistHeader
            // Skip destroys this launcher — flyout AND trigger — so Base UI has no
            // trigger left to restore focus to. Hand keyboard users the main landmark
            // instead of dropping them on <body>.
            onSkipped={focusMainContent}
            title={<PopoverTitle>{ACTIVATION_TITLE}</PopoverTitle>}
            progress={
              <PopoverDescription className="mt-0.5">
                {activationProgressText(checklist)}
              </PopoverDescription>
            }
          />
        }
      >
        <ActivationChecklistItems checklist={checklist} onActivate={() => setOpen(false)} />
      </SidebarFlyout>
      {/* Described by, not nested in, the trigger: `SidebarMenuBadge` is a positioned
          sibling, so `aria-describedby` is what carries progress to screen readers. */}
      <SidebarMenuBadge id={progressId}>
        {checklist.completedCount} of {checklist.total}
      </SidebarMenuBadge>
    </SidebarMenuItem>
  );
}
