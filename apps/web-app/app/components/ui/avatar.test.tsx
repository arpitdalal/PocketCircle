import { paletteColorForSeed } from "@pocketcircle/domain";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar } from "./avatar.js";

describe("Avatar", () => {
  it("renders the Profile Picture when an image is given", () => {
    const { container } = render(<Avatar name="Olive Owner" image="https://example.com/o.png" />);
    const img = container.querySelector("img");
    expect(img).toHaveAttribute("src", "https://example.com/o.png");
    // Decorative: the adjacent display name carries the identity, so the avatar
    // must not be announced (empty alt + aria-hidden).
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("aria-hidden", "true");
  });

  it("falls back to generated initials when there is no image", () => {
    const { container } = render(<Avatar name="Maya Member" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("MM");
  });

  it("stays decorative (aria-hidden) in the initials fallback", () => {
    const { container } = render(<Avatar name="Alex" />);
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
  });

  it("falls back to initials when a present image fails to load", () => {
    // Google profile-image URLs can expire/403; a set image prop is not a
    // guarantee it renders, so onError must swap to the initials chip.
    const { container } = render(
      <Avatar name="Olive Owner" image="https://example.com/dead.png" />,
    );
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    fireEvent.error(img ?? new Image());
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("OO");
  });

  it("tints the initials chip with a palette color derived from the name", () => {
    const { container } = render(<Avatar name="Maya Member" />);
    // Seeded on the normalized Display Name, so it is the same person's color in
    // every Circle (the materialized identity mirrors one profile onto all active
    // memberships) without the client ever needing the raw userId.
    expect(container.firstChild).toHaveStyle({
      color: paletteColorForSeed("maya member").hex,
    });
  });

  it("gives the same name the same color regardless of casing or surrounding space", () => {
    const { container: a } = render(<Avatar name="Maya Member" />);
    const { container: b } = render(<Avatar name="  maya member  " />);
    const colorOf = (root: HTMLElement) =>
      (root.firstChild instanceof HTMLElement ? root.firstChild : null)?.style.color;
    expect(colorOf(a)).toBe(colorOf(b));
  });
});
