import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { MAIN_CONTENT_ID, SkipNavigation } from "./skip-navigation.js";

/**
 * Skip link (issue #312). Pure presentation + focus handoff — no router/backend.
 * Targets a sibling landmark the way the authenticated shell wires `<main>`.
 */
describe("SkipNavigation", () => {
  it("is the first tab stop and moves focus to the main landmark on activate", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <SkipNavigation />
        <a href="/elsewhere">Header link</a>
        <main id={MAIN_CONTENT_ID} tabIndex={-1}>
          <a href="/inside">Inside main</a>
        </main>
      </div>,
    );

    await user.tab();
    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.getByRole("main")).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("link", { name: "Inside main" })).toHaveFocus();
  });

  it("points at the shared main-content id", () => {
    render(<SkipNavigation />);
    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute(
      "href",
      `#${MAIN_CONTENT_ID}`,
    );
  });
});
