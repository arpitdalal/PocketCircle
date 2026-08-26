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
    expect(screen.getByRole("heading", { name: /Email communications$/ })).toBeVisible();
    expect(screen.getByText(/emails are enabled by default for active accounts/i)).toBeVisible();
    expect(screen.getByText(/change this preference in Settings → Privacy/i)).toBeVisible();
    expect(screen.queryByText(/unsubscribe/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/placeholder/i)).not.toBeInTheDocument();

    const contact = screen.getByRole("link", { name: POCKETCIRCLE_SUPPORT_EMAIL });
    expect(contact).toHaveAttribute("href", `mailto:${POCKETCIRCLE_SUPPORT_EMAIL}`);
  });

  it("explains collected data, service providers, analytics, and deletion", () => {
    renderWithRouter(<Privacy />);

    expect(screen.getByRole("heading", { level: 1, name: "Privacy Policy" })).toBeVisible();
    expect(screen.getByText("Effective August 26, 2026")).toBeVisible();
    expect(LEGAL_DOCUMENTS.privacy.effectiveDate).toBe("August 26, 2026");
    expect(LEGAL_DOCUMENTS.terms.effectiveDate).toBe("August 26, 2026");
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
    expect(screen.getAllByText(/Settings → Privacy/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/default on for Users created after this Policy/i)).toBeVisible();
    expect(
      screen.getByText(/Existing stored analytics preferences are not changed by this update/i),
    ).toBeVisible();
    expect(screen.getByText(/Collection starts only after the onboarding notice/i)).toBeVisible();
    expect(screen.getByText(/allowlisted, coarse feature-usage events/i)).toBeVisible();
    expect(
      screen.getByText(/application identifiers, page URLs, or an identified person profile/i),
    ).toBeVisible();
    expect(screen.getByText(/Browser analytics state is memory-only/i)).toBeVisible();
    expect(screen.getByText(/clears in-memory PostHog state/i)).toBeVisible();
    expect(
      screen.getByText(/autocapture, automatic pageviews, and page-leave capture are disabled/i),
    ).toBeVisible();
    expect(
      screen.getByText(/Sentry operational monitoring remains enabled regardless/i),
    ).toBeVisible();
    const emailCommunications = screen
      .getByRole("heading", { name: /Email communications$/ })
      .closest("section");
    expect(emailCommunications).not.toBeNull();
    const emailSection = within(emailCommunications ?? document.body);
    expect(
      emailSection.getByText(/emails are enabled by default for active accounts/i),
    ).toBeVisible();
    expect(emailSection.getByText(/change this preference in Settings → Privacy/i)).toBeVisible();
    expect(emailSection.getByText(/does not affect emails needed to operate/i)).toBeVisible();
    expect(screen.queryByText(/unsubscribe/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/off by default for every user/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/After you opt in, PostHog may use local/i)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Retention and Account Deletion$/ })).toBeVisible();
  });
});
