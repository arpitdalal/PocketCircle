import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { buttonVariants } from "~/components/ui/button-variants.js";
import {
  mobileSheetBackdropClassName,
  mobileSheetPopupBaseClassName,
} from "~/components/ui/mobile-sheet-primitives.js";
import { cn } from "~/lib/utils.js";

export function FilterPanel({
  open,
  onOpenChange,
  title,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={mobileSheetBackdropClassName}
          data-testid="filter-panel-backdrop"
        />
        <Dialog.Popup
          className={cn(
            mobileSheetPopupBaseClassName,
            "md:inset-y-0 md:right-0 md:left-auto md:h-dvh md:max-h-none md:w-[380px] md:rounded-none md:border-t-0 md:border-l md:data-open:animate-panel-side",
          )}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
            <Dialog.Description className="sr-only">
              Adjust filters, then apply or reset them.
            </Dialog.Description>
            <Dialog.Close
              type="button"
              className={cn(buttonVariants({ variant: "ghost" }), "size-9 p-0")}
              aria-label="Close filters"
            >
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
          <div className="flex gap-2 border-t border-border px-4 pt-3 pb-[max(0.75rem,var(--safe-area-bottom))] md:pb-3">
            {footer}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
