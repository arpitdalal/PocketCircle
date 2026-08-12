import { INVITATION_SUBJECT } from "@pocketcircle/domain";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderRoutes } from "~/test/convex-react.js";

vi.mock("~/lib/env.js", () => ({ E2E: false }));

import EmailPreviewRoute, {
  clientLoader,
  emailPreviewAllowed,
  runEmailPreviewGate,
} from "./email-preview.js";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderEmailPreview() {
  return renderRoutes(<Route path="/dev/email-preview" element={<EmailPreviewRoute />} />, {
    initialEntries: ["/dev/email-preview"],
  });
}

describe("Email preview route", () => {
  it("renders the template selector and welcome preview by default", () => {
    renderEmailPreview();
    expect(screen.getByRole("heading", { name: "Email preview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Welcome" })).toBeInTheDocument();
    expect(screen.getByText("Welcome to PocketCircle")).toBeInTheDocument();
    expect(screen.getByTitle("Email preview")).toBeInTheDocument();
  });

  it("renders the invitation template with sample circle name and invite link in the iframe", async () => {
    const user = userEvent.setup();
    renderEmailPreview();

    await user.click(screen.getByRole("button", { name: "Invitation" }));

    expect(screen.getByText(INVITATION_SUBJECT)).toBeInTheDocument();
    const iframe = screen.getByTitle("Email preview");
    expect(iframe.getAttribute("srcdoc")).toContain("Weekend Trip");
    expect(iframe.getAttribute("srcdoc")).toContain("https://app.example.com/invite/sample-token");
  });

  it("updates the iframe when a field value changes", async () => {
    const user = userEvent.setup();
    renderEmailPreview();

    await user.click(screen.getByRole("button", { name: "Invitation" }));
    const circleNameInput = screen.getByLabelText("Circle name");
    await user.clear(circleNameInput);
    await user.type(circleNameInput, "Lake House");

    const iframe = screen.getByTitle("Email preview");
    expect(iframe.getAttribute("srcdoc")).toContain("Lake House");
  });

  it("404s when neither dev nor E2E", () => {
    expect(emailPreviewAllowed(false, false)).toBe(false);
    try {
      runEmailPreviewGate(false, false);
      expect.unreachable("expected 404 gate to throw");
    } catch (error) {
      if (!(error instanceof Response)) {
        throw error;
      }
      expect(error.status).toBe(404);
    }
  });

  it("clientLoader succeeds in dev test mode", async () => {
    expect(emailPreviewAllowed(true, false)).toBe(true);
    await expect(clientLoader()).resolves.toBeNull();
  });
});

describe("emailPreviewAllowed", () => {
  it("allows E2E without dev", () => {
    expect(emailPreviewAllowed(false, true)).toBe(true);
  });
});
