import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./input-group.js";

describe("InputGroup", () => {
  it("activates a nested button with Enter without preventDefault swallowing it", async () => {
    const onCopy = vi.fn();
    const user = userEvent.setup();
    render(
      <InputGroup>
        <InputGroupInput readOnly value="https://mcp.example/mcp" aria-label="MCP server URL" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton type="button" onClick={onCopy}>
            Copy
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>,
    );

    const button = screen.getByRole("button", { name: "Copy" });
    button.focus();
    await user.keyboard("{Enter}");
    expect(onCopy).toHaveBeenCalledOnce();
  });
});
