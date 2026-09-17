import { X } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { buttonVariants } from "~/components/ui/button-variants.js";
import { Popover, PopoverClose, PopoverContent, PopoverHeader } from "~/components/ui/popover.js";
import { cn } from "~/lib/utils.js";

/**
 * Geometry shared by the desktop sidebar's popovers (issue #351): non-modal, to the
 * right of the panel, aligned toward the bottom with an 8px gap, ~22rem wide, body
 * scrolling under a maximum height near 70dvh. Encoded once so the activation flyout
 * and the changelog preview cannot drift apart.
 *
 * `keepMounted` keeps the content in the tree (Base UI marks it `hidden`) while closed
 * — the activation flyout needs it because closing hands off to a modal Circle picker
 * its own content owns.
 *
 * Opening focus lands on the popup itself, which Base UI renders as a labelled
 * `role="dialog"` with `tabIndex=-1` — the WAI-ARIA APG recommendation for a dialog whose
 * content is structured (both flyouts are lists). Focusing the first tabbable child
 * instead would put the changelog's archive link under Enter, and the checklist's
 * irreversible "Skip onboarding" under Enter and Space.
 *
 * Every flyout carries a Close button: Base UI's popup is a `role="dialog"`, and the APG
 * strongly recommends a visible control in its tab sequence — a touch screen-reader user
 * has no Escape key and no outside-click.
 */
export function SidebarFlyout({
  open,
  onOpenChange,
  keepMounted,
  trigger,
  header,
  footer,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  keepMounted?: boolean;
  trigger: ReactNode;
  header: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const popupRef = useRef<HTMLDivElement>(null);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {trigger}
      <PopoverContent
        ref={popupRef}
        side="right"
        align="end"
        sideOffset={8}
        keepMounted={keepMounted}
        initialFocus={popupRef}
        className="flex max-h-[min(70dvh,var(--available-height,70dvh))] w-88 flex-col"
      >
        <PopoverHeader className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">{header}</div>
          <PopoverClose
            type="button"
            aria-label="Close"
            className={cn(
              buttonVariants({ variant: "ghost" }),
              "size-8 shrink-0 p-0 focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            <X className="size-4" aria-hidden />
          </PopoverClose>
        </PopoverHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer ? <div className="border-t border-border px-4 py-2">{footer}</div> : null}
      </PopoverContent>
    </Popover>
  );
}
