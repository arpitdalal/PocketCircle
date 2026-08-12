import { LEGAL_DOCUMENTS, POCKETCIRCLE_SUPPORT_EMAIL } from "@pocketcircle/domain";
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithRouter } from "~/test/convex-react.js";
import Privacy from "./privacy.js";
import Terms from "./terms.js";

describe("legal pages", () => {
  it("publishes substantive beta Terms with the support contact", () => {
    renderWithRouter(<Terms />);

    expect(screen.getByRole("heading", { level: 1, name: "Terms & Conditions" })).toBeVisible();
    expect(screen.getByText(`Effective ${LEGAL_DOCUMENTS.terms.effectiveDate}`)).toBeVisible();
    expect(screen.getByRole("heading", { name: /Shared Circles and your content$/ })).toBeVisible();
    expect(screen.getByRole("heading", { name: /Beta service and availability$/ })).toBeVisible();
    expect(screen.queryByText(/placeholder/i)).not.toBeInTheDocument();

    const contact = screen.getByRole("link", { name: POCKETCIRCLE_SUPPORT_EMAIL });
    expect(contact).toHaveAttribute("href", `mailto:${POCKETCIRCLE_SUPPORT_EMAIL}`);
  });

  it("explains collected data, service providers, analytics, and deletion", () => {
    renderWithRouter(<Privacy />);

    expect(screen.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
    expect(screen.getByText(`Effective ${LEGAL_DOCUMENTS.privacy.effectiveDate}`)).toBeVisible();
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
