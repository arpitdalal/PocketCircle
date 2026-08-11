import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import Privacy from "./privacy.js";
import Terms from "./terms.js";

function renderPage(page: React.ReactNode) {
  render(<MemoryRouter>{page}</MemoryRouter>);
}

describe("legal pages", () => {
  it("publishes substantive beta Terms with the support contact", () => {
    renderPage(<Terms />);

    expect(screen.getByRole("heading", { level: 1, name: "Terms & Conditions" })).toBeVisible();
    expect(screen.getByText("Effective August 11, 2026")).toBeVisible();
    expect(screen.getByRole("heading", { name: /Shared Circles and your content$/ })).toBeVisible();
    expect(screen.getByRole("heading", { name: /Beta service and availability$/ })).toBeVisible();
    expect(screen.queryByText(/placeholder/i)).not.toBeInTheDocument();

    const contact = screen.getByRole("link", { name: "arpitdalalm@gmail.com" });
    expect(contact).toHaveAttribute("href", "mailto:arpitdalalm@gmail.com");
  });

  it("explains collected data, service providers, analytics, and deletion", () => {
    renderPage(<Privacy />);

    expect(screen.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
    expect(screen.getByText("Effective August 11, 2026")).toBeVisible();
    expect(screen.queryByText(/placeholder/i)).not.toBeInTheDocument();

    const providers = screen
      .getByRole("heading", { name: /Service providers$/ })
      .closest("section");
    expect(providers).not.toBeNull();
    const providerSection = within(providers ?? document.body);
    for (const provider of ["Google", "Convex", "Cloudflare", "Resend", "Sentry", "PostHog"]) {
      expect(providerSection.getByText(new RegExp(provider))).toBeVisible();
    }

    expect(screen.getByText(/error-triggered Session Replay/i)).toBeVisible();
    expect(screen.getByText(/Settings → Privacy/i)).toBeVisible();
    expect(screen.getByRole("heading", { name: /Retention and Account Deletion$/ })).toBeVisible();
  });
});
