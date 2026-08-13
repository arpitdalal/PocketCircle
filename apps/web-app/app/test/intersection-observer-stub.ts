import { afterAll, beforeAll, beforeEach } from "vitest";

/**
 * jsdom has no `IntersectionObserver` — a minimal test double at the browser boundary
 * (ADR 0006). Register instances in a live set; tests call {@link flushIntersectionObserverStub}
 * to deliver synthetic entries. Reuse for any route that wires infinite scroll.
 */

export class IntersectionObserverStub implements IntersectionObserver {
  private static readonly live = new Set<IntersectionObserverStub>();

  static disconnectAllForTests() {
    for (const io of [...IntersectionObserverStub.live]) {
      io.disconnect();
    }
  }

  static flushAll(isIntersecting = true) {
    for (const io of IntersectionObserverStub.live) {
      io.deliver(isIntersecting);
    }
  }

  readonly root: Element | Document | null = null;
  readonly rootMargin = "";
  readonly scrollMargin = "";
  readonly thresholds: ReadonlyArray<number> = [0];
  private readonly observed = new Set<Element>();

  constructor(
    private readonly intersectionCallback: IntersectionObserverCallback,
    _init?: IntersectionObserverInit,
  ) {
    IntersectionObserverStub.live.add(this);
  }

  observe(element: Element) {
    this.observed.add(element);
  }

  unobserve(element: Element) {
    this.observed.delete(element);
  }

  disconnect() {
    IntersectionObserverStub.live.delete(this);
    this.observed.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  private deliver(isIntersecting: boolean) {
    for (const target of this.observed) {
      const boundingClientRect = target.getBoundingClientRect();
      const entry: IntersectionObserverEntry = {
        isIntersecting,
        target,
        boundingClientRect,
        intersectionRect: boundingClientRect,
        rootBounds: null,
        intersectionRatio: isIntersecting ? 1 : 0,
        time: performance.now(),
      };
      this.intersectionCallback([entry], this);
    }
  }
}

export function flushIntersectionObserverStub(isIntersecting = true) {
  IntersectionObserverStub.flushAll(isIntersecting);
}

/**
 * Registers vitest hooks that swap in {@link IntersectionObserverStub} and reset observers
 * between tests. Call once at the start of a `describe` block (not at module scope).
 */
export function installIntersectionObserverStub() {
  const saved = globalThis.IntersectionObserver;
  beforeAll(() => {
    globalThis.IntersectionObserver = IntersectionObserverStub;
  });
  afterAll(() => {
    IntersectionObserverStub.disconnectAllForTests();
    globalThis.IntersectionObserver = saved;
  });
  beforeEach(() => {
    IntersectionObserverStub.disconnectAllForTests();
  });
}
