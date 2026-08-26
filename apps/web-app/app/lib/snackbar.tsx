import { createContext, type ReactNode, use, useCallback, useMemo, useRef, useState } from "react";

/**
 * The closed vocabulary of non-revealing "unavailable" messages (ADR 0016/0017).
 * Callers pass a `target` token, never free text, so every anti-enumeration string
 * lives in this one auditable place and cannot drift or leak per call site — within
 * a target the same copy is shown whether the object is missing or merely
 * inaccessible, so nothing leaks about its existence. Arbitrary snackbar copy goes
 * through `show` instead, deliberately outside this constrained path.
 */
const UNAVAILABLE_MESSAGES = {
  link: "That link isn't available.",
  circle: "This circle isn't available.",
} as const;

export type UnavailableTarget = keyof typeof UNAVAILABLE_MESSAGES;

interface SnackbarContextValue {
  show: (message: string) => void;
  showUnavailable: (target?: UnavailableTarget) => void;
}

const SnackbarContext = createContext<SnackbarContextValue | null>(null);

const SNACKBAR_LIFETIME_MS = 4000;

export function SnackbarProvider({ children }: { children: ReactNode }) {
  const [announcement, setAnnouncement] = useState<{
    message: string;
    generation: number;
  } | null>(null);
  const generationRef = useRef(0);
  const dismissCleanupRef = useRef<(() => void) | null>(null);

  const show = useCallback((next: string) => {
    dismissCleanupRef.current?.();
    generationRef.current += 1;
    const generation = generationRef.current;
    setAnnouncement({ message: next, generation });
    const timeoutId = window.setTimeout(() => {
      setAnnouncement((current) => (current?.generation === generation ? null : current));
      dismissCleanupRef.current = null;
    }, SNACKBAR_LIFETIME_MS);
    dismissCleanupRef.current = () => {
      window.clearTimeout(timeoutId);
      dismissCleanupRef.current = null;
    };
  }, []);

  const showUnavailable = useCallback(
    (target: UnavailableTarget = "link") => {
      show(UNAVAILABLE_MESSAGES[target]);
    },
    [show],
  );

  const contextValue = useMemo(() => ({ show, showUnavailable }), [show, showUnavailable]);

  return (
    <SnackbarContext.Provider value={contextValue}>
      {children}
      {announcement ? (
        // aria-live polite announcements — not role="status". The old <output> tag
        // exposed an implicit status landmark that collided with page-level status
        // regions (Members transfer success, invite confirmation, skeleton loaders).
        // generation key remounts so identical successive messages re-announce and an
        // older timeout cannot dismiss a newer message (issue #287).
        <div
          key={announcement.generation}
          aria-live="polite"
          aria-atomic="true"
          className="fixed inset-x-0 bottom-4 z-60 mx-auto block w-fit max-w-[90vw] animate-slide-up rounded-lg border border-border bg-popover px-4 py-2.5 text-center text-sm text-popover-foreground shadow-lg"
        >
          {announcement.message}
        </div>
      ) : null}
    </SnackbarContext.Provider>
  );
}

export function useSnackbar(): SnackbarContextValue {
  const context = use(SnackbarContext);
  if (!context) {
    throw new Error("useSnackbar must be used within a SnackbarProvider");
  }
  return context;
}
