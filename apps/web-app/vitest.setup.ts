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

// jsdom ships no IntersectionObserver; React Router's `<Link prefetch="viewport">`
// (the mobile bottom bar — issue #121) wires one on mount. A no-op satisfies it —
// nothing ever scrolls into view in jsdom, so no prefetch fires. Tests that need to
// DELIVER intersections install the richer `IntersectionObserverStub` over this.
if (typeof globalThis.IntersectionObserver === "undefined") {
  globalThis.IntersectionObserver = class {
    readonly root = null;
    readonly rootMargin = "";
    readonly scrollMargin = "";
    readonly thresholds: ReadonlyArray<number> = [];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  };
}

// The MSW node server is enabled unconditionally for the whole unit/integration
// suite so tests never reach real vendors (ADR 0006).
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());
