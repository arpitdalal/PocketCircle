/**
 * Browser-API boundary fakes for PWA install tests (issue #262).
 * Emulates `matchMedia`, navigator install/standalone bits, and Chromium's
 * `beforeinstallprompt` / `appinstalled` events — the true boundary. Never mocks
 * `usePwaInstall` or the provider.
 */
import { vi } from "vitest";
import { installMatchMediaFake as installMatchMediaQueries } from "./match-media.js";

type NavigatorInstallProps = {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  /** `undefined` removes the property (non-iOS). */
  standalone?: boolean | undefined;
};

const DEFAULT_DESKTOP = {
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0",
  platform: "Linux x86_64",
  maxTouchPoints: 0,
} as const;

/** Standalone display-mode fake — shared matchMedia helper (ADR 0006). */
export function installMatchMediaFake(matchesStandalone: boolean) {
  return installMatchMediaQueries({
    "(display-mode: standalone)": matchesStandalone,
  }).matchMedia;
}

export function setNavigatorInstallProps(props: NavigatorInstallProps = {}) {
  const next = {
    userAgent: props.userAgent ?? DEFAULT_DESKTOP.userAgent,
    platform: props.platform ?? DEFAULT_DESKTOP.platform,
    maxTouchPoints: props.maxTouchPoints ?? DEFAULT_DESKTOP.maxTouchPoints,
  };
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    get: () => next.userAgent,
  });
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    get: () => next.platform,
  });
  Object.defineProperty(navigator, "maxTouchPoints", {
    configurable: true,
    get: () => next.maxTouchPoints,
  });

  if ("standalone" in props) {
    if (props.standalone === undefined) {
      Reflect.deleteProperty(navigator, "standalone");
    } else {
      Object.defineProperty(navigator, "standalone", {
        configurable: true,
        enumerable: true,
        get: () => props.standalone,
      });
    }
  } else if ("standalone" in navigator) {
    Reflect.deleteProperty(navigator, "standalone");
  }
}

export function resetNavigatorInstallProps() {
  setNavigatorInstallProps({
    ...DEFAULT_DESKTOP,
    standalone: undefined,
  });
}

export function dispatchBeforeInstallPrompt(outcome: "accepted" | "dismissed" = "accepted") {
  let resolveChoice: (value: { outcome: "accepted" | "dismissed" }) => void = () => {};
  const userChoice = new Promise<{ outcome: "accepted" | "dismissed" }>((resolve) => {
    resolveChoice = resolve;
  });
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = new Event("beforeinstallprompt", { cancelable: true });
  const preventDefault = vi.spyOn(event, "preventDefault");
  Object.defineProperty(event, "prompt", {
    configurable: true,
    value: prompt,
  });
  Object.defineProperty(event, "userChoice", {
    configurable: true,
    value: userChoice,
  });
  window.dispatchEvent(event);
  return {
    prompt,
    preventDefault,
    resolveOutcome: () => resolveChoice({ outcome }),
  };
}

export function dispatchAppInstalled() {
  window.dispatchEvent(new Event("appinstalled"));
}

export const PWA_INSTALL_PROMPT_DISMISSED_KEY = "pocketcircle.pwaInstallPromptDismissed";

export function clearPwaInstallPromptDismissal() {
  window.localStorage.removeItem(PWA_INSTALL_PROMPT_DISMISSED_KEY);
}

export function seedPwaInstallPromptDismissed() {
  window.localStorage.setItem(PWA_INSTALL_PROMPT_DISMISSED_KEY, "1");
}
