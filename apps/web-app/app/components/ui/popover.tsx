import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { ComponentProps } from "react";
import { cn } from "~/lib/utils.js";

/**
 * Non-modal popover primitive on Base UI Popover, in shadcn/ui's composition
 * (ADR 0005, issue #351): Root, Trigger, Content, Close, Header, Title, Description.
 * Base UI owns positioning, outside-click / Escape dismissal, focus restoration to
 * the trigger, and the portal; this file owns only PocketCircle's surface styling
 * and the Portal → Positioner → Popup nesting that `PopoverContent` hides.
 *
 * `Trigger` takes Base UI's `render` prop, so a sidebar menu row can BE the trigger
 * (`render={<SidebarMenuButton />}`) instead of nesting a second button.
 */

function Popover(props: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root {...props} />;
}

function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

/**
 * Portal + positioner + popup in one part. Positioning props are forwarded to the
 * positioner; everything else lands on the popup.
 *
 * `keepMounted` keeps the content mounted (Base UI marks it `hidden`) while closed —
 * needed when the content owns a surface that must survive its own close, e.g. the
 * activation flyout handing off to the modal Circle picker.
 */
function PopoverContent({
  side = "bottom",
  align = "center",
  sideOffset = 4,
  alignOffset,
  collisionPadding = 8,
  keepMounted,
  className,
  children,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<
    PopoverPrimitive.Positioner.Props,
    "side" | "align" | "sideOffset" | "alignOffset" | "collisionPadding"
  > &
  Pick<PopoverPrimitive.Portal.Props, "keepMounted">) {
  return (
    <PopoverPrimitive.Portal keepMounted={keepMounted}>
      <PopoverPrimitive.Positioner
        side={side}
        align={align}
        sideOffset={sideOffset}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        className="z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            // Keyed off `data-open` rather than mount, because `keepMounted` popups
            // never remount — a mount-only animation would play exactly once.
            // Base UI's documented sizing hook, applied to the POPUP as its docs
            // describe: the space between the anchor and the viewport edge, so the popup
            // shrinks instead of only being shifted by collision handling.
            // `--available-height` is exposed the same way.
            "max-w-(--available-width) origin-(--transform-origin) rounded-lg border border-border bg-popover text-popover-foreground shadow-xl outline-none data-open:animate-pop-in",
            className,
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverClose(props: PopoverPrimitive.Close.Props) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}

function PopoverHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="popover-header"
      className={cn("border-b border-border px-4 py-3", className)}
      {...props}
    />
  );
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      data-slot="popover-title"
      className={cn("font-display text-sm font-semibold tracking-tight", className)}
      {...props}
    />
  );
}

function PopoverDescription({ className, ...props }: PopoverPrimitive.Description.Props) {
  return (
    <PopoverPrimitive.Description
      data-slot="popover-description"
      className={cn("text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
};
