import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getHeadlineMoney } from "../test/money.js";
import { AnimatedMoney } from "./animated-money.js";

vi.mock("@number-flow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@number-flow/react")>();
  return {
    ...actual,
    default: NumberFlowTestDouble,
    NumberFlowGroup: NumberFlowGroupTestDouble,
  };
});

function NumberFlowTestDouble(props: {
  value: number;
  format: Intl.NumberFormatOptions;
  locales: string;
}) {
  return (
    <span data-testid="number-flow" aria-hidden data-notation={props.format.notation ?? "standard"}>
      {new Intl.NumberFormat(props.locales, props.format).format(props.value)}
    </span>
  );
}

function NumberFlowGroupTestDouble({ children }: { children: ReactNode }) {
  return children;
}

function compactUsd(major: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
  }).format(major);
}

describe("AnimatedMoney", () => {
  const savedResizeObserver = globalThis.ResizeObserver;
  const savedLanguage = Object.getOwnPropertyDescriptor(window.navigator, "language");

  class ResizeObserverStub implements ResizeObserver {
    private static readonly live = new Set<ResizeObserverStub>();

    static flushAll() {
      act(() => {
        for (const ro of ResizeObserverStub.live) ro.deliver();
      });
    }

    static disconnectAllForTests() {
      for (const ro of [...ResizeObserverStub.live]) ro.disconnect();
    }

    private readonly observed = new Set<Element>();

    constructor(private readonly callback: ResizeObserverCallback) {
      ResizeObserverStub.live.add(this);
    }

    observe(element: Element) {
      this.observed.add(element);
    }

    unobserve(element: Element) {
      this.observed.delete(element);
    }

    disconnect() {
      ResizeObserverStub.live.delete(this);
      this.observed.clear();
    }

    takeRecords(): ResizeObserverEntry[] {
      return [];
    }

    deliver() {
      for (const target of this.observed) {
        const contentRect = target.getBoundingClientRect();
        this.callback(
          [
            {
              target,
              contentRect,
              borderBoxSize: [],
              contentBoxSize: [],
              devicePixelContentBoxSize: [],
            },
          ],
          this,
        );
      }
    }
  }

  beforeAll(() => {
    globalThis.ResizeObserver = ResizeObserverStub;
    Object.defineProperty(window.navigator, "language", {
      configurable: true,
      get: () => "en-US",
    });
  });

  afterAll(() => {
    globalThis.ResizeObserver = savedResizeObserver;
    if (savedLanguage) {
      Object.defineProperty(window.navigator, "language", savedLanguage);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ResizeObserverStub.disconnectAllForTests();
  });

  function stubWidths(widths: { container: number; text: number }) {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.hasAttribute("data-money") ? widths.container : 0;
    });
    const measureText = vi.fn(() => ({
      width: widths.text,
      actualBoundingBoxAscent: 0,
      actualBoundingBoxDescent: 0,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 0,
      fontBoundingBoxAscent: 0,
      fontBoundingBoxDescent: 0,
    }));
    // True canvas boundary — production only reads `font` + `measureText`.
    // @ts-expect-error incomplete CanvasRenderingContext2D test double
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((type: string) =>
      type === "2d" ? { font: "", measureText } : null,
    );
    return { measureText };
  }

  function renderMoney(overrides?: { minorUnits?: number }) {
    return render(
      <AnimatedMoney
        minorUnits={overrides?.minorUnits ?? 500_000}
        currency="USD"
        motionKey="test"
      />,
    );
  }

  it("formats minor units as currency in the viewer locale", () => {
    stubWidths({ container: 200, text: 100 });
    renderMoney();
    expect(getHeadlineMoney(screen, "$5,000.00")).toBeInTheDocument();
    expect(document.querySelector('[data-money="$5,000.00"]')).toBeInTheDocument();
  });

  it("keeps exact NumberFlow when the amount fits", () => {
    stubWidths({ container: 200, text: 100 });
    renderMoney();
    const flow = screen.getByTestId("number-flow");
    expect(flow).toHaveAttribute("data-notation", "standard");
    expect(flow).toHaveTextContent("$5,000.00");
    expect(document.querySelector("[data-compact-money]")).toBeNull();
  });

  it("keeps NumberFlow with compact notation when the exact amount does not fit", () => {
    stubWidths({ container: 120, text: 300 });
    renderMoney();
    const flow = screen.getByTestId("number-flow");
    expect(flow).toHaveAttribute("data-notation", "compact");
    expect(flow).toHaveTextContent(compactUsd(5000));
    const host = document.querySelector('[data-money="$5,000.00"]');
    expect(host).toHaveAttribute("data-compact-money", compactUsd(5000));
    expect(host).toHaveAttribute("title", "$5,000.00");
    expect(getHeadlineMoney(screen, "$5,000.00")).toBeInTheDocument();
  });

  it("uses compact NumberFlow for negative net amounts when they do not fit", () => {
    stubWidths({ container: 60, text: 120 });
    renderMoney({ minorUnits: -4_200 });
    const flow = screen.getByTestId("number-flow");
    expect(flow).toHaveAttribute("data-notation", "compact");
    expect(flow).toHaveTextContent(compactUsd(-42));
    expect(document.querySelector('[data-money="-$42.00"]')).toBeInTheDocument();
  });

  it("reacts to a container resize by swapping exact and compact NumberFlow formats", () => {
    const stubs = stubWidths({ container: 200, text: 100 });
    renderMoney();
    expect(screen.getByTestId("number-flow")).toHaveAttribute("data-notation", "standard");

    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.hasAttribute("data-money") ? 40 : 0;
    });
    stubs.measureText.mockReturnValue({
      width: 300,
      actualBoundingBoxAscent: 0,
      actualBoundingBoxDescent: 0,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 0,
      fontBoundingBoxAscent: 0,
      fontBoundingBoxDescent: 0,
    });
    ResizeObserverStub.flushAll();

    expect(screen.getByTestId("number-flow")).toHaveAttribute("data-notation", "compact");
    expect(screen.getByTestId("number-flow")).toHaveTextContent(compactUsd(5000));

    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.hasAttribute("data-money") ? 500 : 0;
    });
    stubs.measureText.mockReturnValue({
      width: 100,
      actualBoundingBoxAscent: 0,
      actualBoundingBoxDescent: 0,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 0,
      fontBoundingBoxAscent: 0,
      fontBoundingBoxDescent: 0,
    });
    ResizeObserverStub.flushAll();

    expect(screen.getByTestId("number-flow")).toHaveAttribute("data-notation", "standard");
    expect(document.querySelector("[data-compact-money]")).toBeNull();
  });

  it("remeasures after document fonts settle so a late web-font swap can compact", async () => {
    let resolveFontsReady!: () => void;
    const fontsReady = new Promise<FontFaceSet>((resolve) => {
      resolveFontsReady = () => resolve(document.fonts);
    });
    const listeners = new Set<() => void>();
    const fontsStub = {
      ready: fontsReady,
      addEventListener(_type: string, listener: () => void) {
        listeners.add(listener);
      },
      removeEventListener(_type: string, listener: () => void) {
        listeners.delete(listener);
      },
    };
    const previousFonts = Object.getOwnPropertyDescriptor(Document.prototype, "fonts");
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: fontsStub,
    });

    try {
      const stubs = stubWidths({ container: 120, text: 80 });
      renderMoney();
      expect(screen.getByTestId("number-flow")).toHaveAttribute("data-notation", "standard");

      stubs.measureText.mockReturnValue({
        width: 300,
        actualBoundingBoxAscent: 0,
        actualBoundingBoxDescent: 0,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: 0,
        fontBoundingBoxAscent: 0,
        fontBoundingBoxDescent: 0,
      });
      await act(async () => {
        resolveFontsReady();
        await fontsReady;
      });

      expect(screen.getByTestId("number-flow")).toHaveAttribute("data-notation", "compact");
      expect(screen.getByTestId("number-flow")).toHaveTextContent(compactUsd(5000));
    } finally {
      if (previousFonts) {
        Object.defineProperty(Document.prototype, "fonts", previousFonts);
      }
      // Own property override from this test — drop it so later cases see the prototype.
      Reflect.deleteProperty(document, "fonts");
    }
  });

  it("keeps the exact sr-only amount when compact NumberFlow is shown", () => {
    stubWidths({ container: 50, text: 250 });
    renderMoney({ minorUnits: 123_456_789 });
    expect(getHeadlineMoney(screen, "$1,234,567.89")).toBeInTheDocument();
    expect(screen.getByTestId("number-flow")).toHaveAttribute("data-notation", "compact");
    expect(screen.getByTestId("number-flow")).toHaveTextContent(compactUsd(1_234_567.89));
  });
});
