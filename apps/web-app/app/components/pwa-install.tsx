import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { createContext, type ReactNode, use, useId, useState, useSyncExternalStore } from "react";
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

type PwaInstallAvailability = "unavailable" | "chromium" | "ios";

type InstallSnapshot = {
  availability: PwaInstallAvailability;
  deferredPrompt: BeforeInstallPromptEventLike | null;
};

const SERVER_SNAPSHOT: InstallSnapshot = {
  availability: "unavailable",
  deferredPrompt: null,
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

    if (isIosDevice()) {
      snapshot = { availability: "ios", deferredPrompt: null };
    }

    const onBeforeInstallPrompt = (event: Event) => {
      if (!isBeforeInstallPromptEvent(event)) {
        return;
      }
      event.preventDefault();
      replace({ availability: "chromium", deferredPrompt: event });
    };

    const onAppInstalled = () => {
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

  return {
    subscribe,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => SERVER_SNAPSHOT,
    replace,
  };
}

interface PwaInstallContextValue {
  available: boolean;
  install: () => void;
}

const PwaInstallContext = createContext<PwaInstallContextValue | null>(null);

/**
 * App-wide PWA install lifecycle (issue #262). Mounts above auth so
 * `beforeinstallprompt` is not missed while the session resolves. Owns the iOS
 * instruction sheet; AccountMenu only reads availability + `install()`.
 */
export function PwaInstallProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createPwaInstallStore);

  const { availability, deferredPrompt } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  const [iosInstructionsOpen, setIosInstructionsOpen] = useState(false);

  // Close the iOS sheet if installability flips to unavailable (e.g. appinstalled).
  if (availability === "unavailable" && iosInstructionsOpen) {
    setIosInstructionsOpen(false);
  }

  const install = () => {
    if (availability === "ios") {
      setIosInstructionsOpen(true);
      return;
    }
    if (availability !== "chromium" || deferredPrompt == null) {
      return;
    }
    const promptEvent = deferredPrompt;
    void (async () => {
      await promptEvent.prompt();
      await promptEvent.userChoice;
      store.replace(SERVER_SNAPSHOT);
    })();
  };

  return (
    <PwaInstallContext.Provider
      value={{
        available: availability !== "unavailable",
        install,
      }}
    >
      {children}
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
            "gap-4 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4",
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
