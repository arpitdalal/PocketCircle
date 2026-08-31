import "@testing-library/jest-dom/vitest";
import { server } from "@pocketcircle/mocks/server";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll } from "vitest";

// jsdom ships no ResizeObserver; Recharts' ResponsiveContainer (the Dashboard
// chart — RPT-4) requires one to mount. A no-op satisfies it: jsdom boxes have no
// real layout, so there is never a resize to observe, and the chart's DATA is
// asserted through its accessible table rather than rendered SVG geometry.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// jsdom / Node 26 may omit Web Storage; analytics leftover-key cleanup needs it.
function createMemoryStorage() {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key(index: number) {
      return [...data.keys()][index] ?? null;
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      data.set(key, String(value));
    },
    removeItem(key: string) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
  };
}

function hasStorageApi(value: unknown) {
  return (
    typeof value === "object" &&
    value !== null &&
    "getItem" in value &&
    typeof value.getItem === "function" &&
    "setItem" in value &&
    typeof value.setItem === "function" &&
    "removeItem" in value &&
    typeof value.removeItem === "function" &&
    "clear" in value &&
    typeof value.clear === "function"
  );
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  if (!hasStorageApi(globalThis[name])) {
    Object.defineProperty(window, name, {
      configurable: true,
      enumerable: true,
      value: createMemoryStorage(),
    });
  }
}

// jsdom ships no IntersectionObserver; React Router's `<Link prefetch="viewport">`
// (the mobile bottom bar — issue #121) wires one on mount. A no-op satisfies it —
// nothing ever scrolls into view in jsdom, so no prefetch fires. Tests that need to
// DELIVER intersections install the richer `IntersectionObserverStub` over this.
if (typeof globalThis.IntersectionObserver === "undefined") {
  globalThis.IntersectionObserver = class {
    readonly root = null;
    readonly rootMargin = "";
    readonly scrollMargin = "0px 0px 0px 0px";
    readonly thresholds: ReadonlyArray<number> = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  };
}

// jsdom ships no scrollIntoView; Global Add Step 2 (issue #298) scrolls the
// form container into view after Circle selection. A no-op keeps suites from
// throwing; tests that assert scroll spy via `vi.spyOn(Element.prototype, …)`.
if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// jsdom ships no matchMedia; PwaInstallProvider (#262) reads display-mode on mount.
// Default to non-standalone. Suites that need a specific match install
// `installMatchMediaFake` from `~/test/pwa-install-env.js` over this.
if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    }),
  });
}
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());
