import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Button } from "./button.js";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "./popover.js";

/**
 * Only PocketCircle's own contracts (issue #351): the Portal → Positioner → Popup
 * nesting `PopoverContent` hides, title/description wiring, `render`-prop triggers, and
 * `keepMounted`. Base UI owns positioning, dismissal, focus restoration, and portals —
 * those are its tests, not ours.
 */
function TestPopover({ keepMounted }: { keepMounted?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline">Get started</Button>} />
      <PopoverContent keepMounted={keepMounted}>
        <PopoverHeader>
          <PopoverTitle>Get started</PopoverTitle>
          <PopoverDescription>2 of 4 complete</PopoverDescription>
        </PopoverHeader>
        <p>Checklist body</p>
      </PopoverContent>
    </Popover>
  );
}

describe("Popover", () => {
  it("uses the trigger's own element and reports its expanded state", async () => {
    render(<TestPopover />);

    // `render` composes an existing control instead of nesting a second button.
    const trigger = screen.getByRole("button", { name: "Get started" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Checklist body")).not.toBeInTheDocument();

    await userEvent.click(trigger);

    expect(await screen.findByText("Checklist body")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("labels and describes the popup from its title and description", async () => {
    render(<TestPopover />);
    await userEvent.click(screen.getByRole("button", { name: "Get started" }));

    const popup = await screen.findByRole("dialog");
    expect(popup).toHaveAccessibleName("Get started");
    expect(popup).toHaveAccessibleDescription("2 of 4 complete");
    expect(popup.dataset.slot).toBe("popover-content");
  });

  it("mounts nothing while closed by default", () => {
    render(<TestPopover />);
    expect(document.querySelector('[data-slot="popover-content"]')).toBeNull();
  });

  it("keeps the content mounted but hidden while closed when asked", async () => {
    render(<TestPopover keepMounted />);

    // Needed by the activation flyout: closing hands off to a modal its content owns.
    const popup = document.querySelector('[data-slot="popover-content"]');
    expect(popup).not.toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Get started" }));
    expect(await screen.findByRole("dialog")).toBe(popup);
  });

  it("animates on open state rather than on mount, so reopening a kept-mounted popup animates", async () => {
    render(<TestPopover keepMounted />);
    await userEvent.click(screen.getByRole("button", { name: "Get started" }));

    // A bare `animate-pop-in` would run once for the life of the element.
    expect(await screen.findByRole("dialog")).toHaveClass("data-open:animate-pop-in");
  });
});
