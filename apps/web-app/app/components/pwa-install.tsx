import { Dialog } from "@base-ui/react/dialog";
import { Download, X } from "lucide-react";
import { createContext, type ReactNode, use, useId, useState, useSyncExternalStore } from "react";
import { Button } from "~/components/ui/button.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import {
  mobileSheetBackdropClassName,
  mobileSheetPopupBaseClassName,
} from "~/components/ui/mobile-sheet-primitives.js";
import { cn } from "~/lib/utils.js";

/**
 * Structural shape of Chromium's non-standard `beforeinstallprompt` event.
 * Guarded at runtime — no ambient `BeforeInstallPromptEvent` declaration.
 */
type BeforeInstallPromptEventLike = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function isBeforeInstallPromptEvent(event: Event): event is BeforeInstallPromptEventLike {
  return "prompt" in event && typeof event.prompt === "function";
}

function isStandaloneDisplay() {
  return window.matchMedia("(display-mode: standalone)").matches;
}

function isIosStandaloneNavigator(nav: Navigator) {
  return "standalone" in nav && nav.standalone === true;
}

/** iPhone/iPad/iPod UA, plus iPadOS devices that report as MacIntel with touch. */
function isIosDevice() {
  const { userAgent, platform, maxTouchPoints } = navigator;
  if (/iPhone|iPad|iPod/i.test(userAgent)) {
    return true;
  }
  return platform === "MacIntel" && maxTouchPoints > 1;
}

const PROMPT_DISMISSED_KEY = "pocketcircle.pwaInstallPromptDismissed";

function readPromptDismissed() {
  try {
    return window.localStorage.getItem(PROMPT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writePromptDismissed(dismissed: boolean) {
  try {
    if (dismissed) {
      window.localStorage.setItem(PROMPT_DISMISSED_KEY, "1");
    } else {
      window.localStorage.removeItem(PROMPT_DISMISSED_KEY);
    }
  } catch {
    // Private mode / blocked storage — in-memory snapshot still updates.
  }
}

type PwaInstallAvailability = "unavailable" | "chromium" | "ios";

type InstallSnapshot = {
  availability: PwaInstallAvailability;
  deferredPrompt: BeforeInstallPromptEventLike | null;
  promptDismissed: boolean;
};

const SERVER_SNAPSHOT: InstallSnapshot = {
  availability: "unavailable",
  deferredPrompt: null,
  promptDismissed: false,
};

/**
 * Per-provider store for installability. `useSyncExternalStore` keeps prerender
 * on the server snapshot and only inspects `window`/`navigator` when a client
 * subscriber mounts — no Effect setState, no hydration mismatch (#262).
 */
function createPwaInstallStore() {
  let snapshot: InstallSnapshot = SERVER_SNAPSHOT;
  const listeners = new Set<() => void>();
  let detachWindow: (() => void) | null = null;

  function emit() {
    for (const listener of listeners) {
      listener();
    }
  }

  function replace(next: InstallSnapshot) {
    snapshot = next;
    emit();
  }

  function ensureClientSubscription() {
    if (detachWindow != null) {
      return;
    }

    if (isStandaloneDisplay() || isIosStandaloneNavigator(navigator)) {
      snapshot = SERVER_SNAPSHOT;
      detachWindow = () => {};
      return;
    }

    const promptDismissed = readPromptDismissed();
    if (isIosDevice()) {
      snapshot = { availability: "ios", deferredPrompt: null, promptDismissed };
    } else {
      snapshot = { ...SERVER_SNAPSHOT, promptDismissed };
    }

    const onBeforeInstallPrompt = (event: Event) => {
      if (!isBeforeInstallPromptEvent(event)) {
        return;
      }
      event.preventDefault();
      replace({
        availability: "chromium",
        deferredPrompt: event,
        promptDismissed: snapshot.promptDismissed,
      });
    };

    const onAppInstalled = () => {
      writePromptDismissed(false);
      replace(SERVER_SNAPSHOT);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    detachWindow = () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }

  function subscribe(onStoreChange: () => void) {
    ensureClientSubscription();
    listeners.add(onStoreChange);
    return () => {
      listeners.delete(onStoreChange);
      if (listeners.size === 0 && detachWindow != null) {
        detachWindow();
        detachWindow = null;
        snapshot = SERVER_SNAPSHOT;
      }
    };
  }

  function dismissPrompt() {
    writePromptDismissed(true);
    replace({ ...snapshot, promptDismissed: true });
  }

  /** Take the deferred Chromium prompt exactly once; clears store before `prompt()`. */
  function consumeDeferredPrompt() {
    if (snapshot.availability !== "chromium" || snapshot.deferredPrompt == null) {
      return null;
    }
    const event = snapshot.deferredPrompt;
    writePromptDismissed(false);
    replace(SERVER_SNAPSHOT);
    return event;
  }

  return {
    subscribe,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => SERVER_SNAPSHOT,
    replace,
    dismissPrompt,
    consumeDeferredPrompt,
  };
}

interface PwaInstallContextValue {
  available: boolean;
  /** Soft install dialog — available and not yet dismissed. */
  showInstallPrompt: boolean;
  /** Header shortcut — available after the soft prompt was dismissed. */
  showInstallHeaderButton: boolean;
  install: () => void;
  dismissInstallPrompt: () => void;
}

const PwaInstallContext = createContext<PwaInstallContextValue | null>(null);

/**
 * App-wide PWA install lifecycle (issue #262). Mounts above auth so
 * `beforeinstallprompt` is not missed while the session resolves. Owns the soft
 * install prompt, iOS instruction sheet, and exposes a header shortcut after dismiss.
 */
export function PwaInstallProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createPwaInstallStore);

  const { availability, promptDismissed } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  const [iosInstructionsOpen, setIosInstructionsOpen] = useState(false);

  const available = availability !== "unavailable";
  const showInstallPrompt = available && !promptDismissed;
  const showInstallHeaderButton = available && promptDismissed;

  // Close the iOS sheet if installability flips to unavailable (e.g. appinstalled).
  if (availability === "unavailable" && iosInstructionsOpen) {
    setIosInstructionsOpen(false);
  }

  const install = () => {
    if (availability === "ios") {
      setIosInstructionsOpen(true);
      return;
    }
    // Consume synchronously so a second click in the same turn cannot call prompt() again
    // (BeforeInstallPromptEvent is single-use and rejects with InvalidStateError).
    const promptEvent = store.consumeDeferredPrompt();
    if (promptEvent == null) {
      return;
    }
    void (async () => {
      try {
        await promptEvent.prompt();
        await promptEvent.userChoice;
      } catch {
        // Already consumed, dismissed, or browser-rejected — UI already cleared.
      }
    })();
  };

  const dismissInstallPrompt = () => {
    store.dismissPrompt();
  };

  const installFromPrompt = () => {
    dismissInstallPrompt();
    install();
  };

  return (
    <PwaInstallContext.Provider
      value={{
        available,
        showInstallPrompt,
        showInstallHeaderButton,
        install,
        dismissInstallPrompt,
      }}
    >
      {children}
      <InstallPromoDialog
        open={showInstallPrompt}
        onOpenChange={(open) => {
          if (!open) {
            dismissInstallPrompt();
          }
        }}
        onInstall={installFromPrompt}
      />
      <IosInstallInstructionsDialog
        open={iosInstructionsOpen}
        onOpenChange={setIosInstructionsOpen}
      />
    </PwaInstallContext.Provider>
  );
}

export function usePwaInstall() {
  const context = use(PwaInstallContext);
  if (!context) {
    throw new Error("usePwaInstall must be used within a PwaInstallProvider");
  }
  return context;
}

/** Header shortcut shown after the soft install prompt is dismissed. */
export function PwaInstallHeaderButton() {
  const { showInstallHeaderButton, install } = usePwaInstall();
  if (!showInstallHeaderButton) {
    return null;
  }
  return (
    <button
      type="button"
      aria-label="Install PocketCircle"
      onClick={() => install()}
      className={cn(
        buttonVariants({ variant: "ghost", size: "icon-xs" }),
        "size-10 shrink-0 rounded-full focus-visible:ring-offset-background",
      )}
    >
      <Download aria-hidden className="size-5" />
    </button>
  );
}

function InstallPromoDialog({
  open,
  onOpenChange,
  onInstall,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={mobileSheetBackdropClassName} />
        <Dialog.Popup
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 w-[min(100%-2rem,22rem)] -translate-x-1/2 -translate-y-1/2",
            "space-y-4 rounded-xl border border-border bg-card p-5 shadow-xl outline-none",
            "data-open:animate-fade-in",
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <Dialog.Title
              id={titleId}
              className="font-display text-lg font-semibold tracking-tight"
            >
              Install PocketCircle
            </Dialog.Title>
            <Dialog.Close
              type="button"
              aria-label="Close"
              className={cn(buttonVariants({ variant: "ghost", size: "icon-xs" }))}
            >
              <X aria-hidden className="size-4" />
            </Dialog.Close>
          </div>
          <Dialog.Description id={descriptionId} className="text-sm text-muted-foreground">
            Add PocketCircle to your home screen for a faster, app-like experience.
          </Dialog.Description>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Dialog.Close type="button" className={cn(buttonVariants({ variant: "outline" }))}>
              Not now
            </Dialog.Close>
            <Button type="button" onClick={onInstall}>
              Install
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function IosInstallInstructionsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={mobileSheetBackdropClassName} />
        <Dialog.Popup
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className={cn(
            mobileSheetPopupBaseClassName,
            "gap-4 px-4 pb-[max(1rem,var(--safe-area-bottom))] pt-4",
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <Dialog.Title
              id={titleId}
              className="font-display text-lg font-semibold tracking-tight"
            >
              Install PocketCircle
            </Dialog.Title>
            <Dialog.Close
              type="button"
              aria-label="Close"
              className={cn(buttonVariants({ variant: "ghost", size: "icon-xs" }))}
            >
              <X aria-hidden className="size-4" />
            </Dialog.Close>
          </div>
          <Dialog.Description id={descriptionId} className="text-sm text-muted-foreground">
            Add PocketCircle to your Home Screen so it opens like an app.
          </Dialog.Description>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-foreground">
            <li>
              Tap <span className="font-medium">Share</span>.
            </li>
            <li>
              Tap <span className="font-medium">Add to Home Screen</span>.
            </li>
            <li>
              Turn on <span className="font-medium">Open as Web App</span>, then tap{" "}
              <span className="font-medium">Add</span>.
            </li>
          </ol>
          <p className="text-sm text-muted-foreground">
            If <span className="font-medium text-foreground">Add to Home Screen</span> is
            unavailable, open PocketCircle in Safari and try again.
          </p>
          <Dialog.Close
            type="button"
            className={cn(buttonVariants({ variant: "default" }), "w-full")}
          >
            Got it
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
