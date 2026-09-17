import { describe, expect, it } from "vitest";
import appCss from "~/app.css?raw";
import { chromeMenuPlacement, SIDEBAR_CHROME_QUERY } from "./app-chrome.js";

/**
 * `SIDEBAR_CHROME_QUERY` is a JS MIRROR of Tailwind's `lg`, which the shell's `lg:hidden`
 * / `lg:block` rules use to decide which chrome paints. Nothing links the two, so a theme
 * that redefines `lg` would send popups to the chrome CSS has hidden — this asserts the
 * theme still leaves `lg` at Tailwind's default, which is what the query encodes.
 */
describe("SIDEBAR_CHROME_QUERY", () => {
  it("matches the `lg` breakpoint the stylesheet actually uses", () => {
    const override = appCss.match(/--breakpoint-lg:\s*([^;]+);/);

    expect(override?.[1]?.trim() ?? "64rem").toBe("64rem");
    expect(SIDEBAR_CHROME_QUERY).toBe("(min-width: 64rem)");
  });
});

describe("chromeMenuPlacement", () => {
  // The sidebar sits on the left edge, so a tray wider than the panel has to grow to the
  // right, along the panel, rather than below a trigger that is already at the edge.
  it("sends sidebar menus out to the side and header menus below the bar", () => {
    expect(chromeMenuPlacement("sidebar", "start")).toEqual({ side: "right", align: "start" });
    expect(chromeMenuPlacement("sidebar", "end")).toEqual({ side: "right", align: "end" });
    expect(chromeMenuPlacement("header", "start")).toEqual({ side: "bottom", align: "end" });
  });
});
