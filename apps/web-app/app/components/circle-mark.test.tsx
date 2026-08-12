import { colorHex } from "@pocketcircle/domain";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CircleMark } from "./circle-mark.js";

/**
 * The shared Circle Mark renderer (CS-0). Pure presentation — no router or backend
 * — so it renders directly; it derives only the color hex from the stored color id.
 */
describe("CircleMark", () => {
  it("renders the stored mark glyph tinted with the Circle Color", () => {
    render(<CircleMark mark="MH" color="green" />);
    const mark = screen.getByText("MH");
    const hex = colorHex("green");
    expect(mark).toHaveStyle({ color: hex });
    expect(mark).toHaveStyle({ backgroundColor: `${hex}26` });
  });

  it("falls back to the default color tint for an unknown color id", () => {
    render(<CircleMark mark="P" color="not-a-color" />);
    expect(screen.getByText("P")).toHaveStyle({ color: colorHex("not-a-color") });
  });

  it("is decorative (aria-hidden) so it never double-reads the adjacent name", () => {
    render(<CircleMark mark="T" color="blue" />);
    expect(screen.getByText("T")).toHaveAttribute("aria-hidden", "true");
  });

  it("applies a caller's className override", () => {
    render(<CircleMark mark="T" color="blue" className="size-6" />);
    expect(screen.getByText("T")).toHaveClass("size-6");
  });
});
