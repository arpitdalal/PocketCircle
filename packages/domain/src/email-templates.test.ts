import { describe, expect, it } from "vitest";
import {
  ACCOUNT_DELETION_SUBJECT,
  accountDeletionEmail,
  EMAIL_PREVIEWS,
  feedbackEmail,
  invitationEmail,
  invitationSubject,
  WELCOME_SUBJECT,
  welcomeEmail,
} from "./email-templates.js";

const FINANCIAL_PATTERN = /\$|\bUSD\b|\bEUR\b|\bGBP\b|\bamount\b|\bbalance\b|\d+\.\d{2}/i;
const BRAND_PRIMARY = "#7C47D9";

describe("welcomeEmail", () => {
  it("returns the welcome subject and branded HTML with the display name", () => {
    const { subject, html } = welcomeEmail({
      displayName: "Ada Lovelace",
      appUrl: "https://app.example.com",
    });
    expect(subject).toBe(WELCOME_SUBJECT);
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Welcome to PocketCircle");
    expect(html).toContain("Personal Circle");
    expect(html).toContain(BRAND_PRIMARY);
    expect(html).toContain("https://app.example.com/logo.png");
    expect(html).toContain("Open PocketCircle");
    expect(html).toContain("— The PocketCircle team");
    expect(html).not.toMatch(FINANCIAL_PATTERN);
  });
});

describe("invitationEmail", () => {
  it("includes circle name in subject, CTA, and post-CTA copy (#376)", () => {
    const { subject, html } = invitationEmail({
      inviteLink: "https://app.example.com/invite/abc123",
      circleName: "Trip",
      ownerDisplayName: "Olive Owner",
      recipientEmail: "ada@example.com",
    });
    expect(subject).toBe(invitationSubject("Trip"));
    expect(subject).toContain("Trip");
    expect(html).toContain("ada@example.com");
    expect(html).toContain("Olive Owner");
    expect(html).toContain("Trip");
    expect(html).toContain("Accept invitation to Trip");
    expect(html).not.toContain("You're joining");
    expect(html).toContain("https://app.example.com/invite/abc123");
    expect(html).toContain("expires in 7 days");
    expect(html).toContain("PocketCircle · invitation to Trip");
    expect(html).toContain("— The PocketCircle team");
    expect(html).toContain(BRAND_PRIMARY);
    expect(html).toContain("https://app.example.com/logo.png");
    expect(html).not.toMatch(FINANCIAL_PATTERN);
    expect(html).not.toMatch(/\b(avatar|ownerImage)\b/i);
    // Expiry sits above the CTA so the button is the last body action.
    expect(html.indexOf("expires in 7 days")).toBeLessThan(
      html.indexOf("Accept invitation to Trip"),
    );
  });

  it("uses the same team signature as welcome", () => {
    const welcome = welcomeEmail({
      displayName: "Ada",
      appUrl: "https://app.example.com",
    }).html;
    const invite = invitationEmail({
      inviteLink: "https://app.example.com/invite/t",
      circleName: "Trip",
      ownerDisplayName: "Olive",
      recipientEmail: "a@b.com",
    }).html;
    expect(welcome).toContain("— The PocketCircle team");
    expect(invite).toContain("— The PocketCircle team");
  });

  it("escapes HTML-special chars in interpolated values", () => {
    const { subject, html } = invitationEmail({
      inviteLink: "https://app.example.com/invite/tok",
      circleName: "<script>",
      ownerDisplayName: 'O"wn',
      recipientEmail: "a&b@example.com",
    });
    expect(subject).toBe(invitationSubject("<script>"));
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("a&amp;b@example.com");
    expect(html).toContain("O&quot;wn");
  });
});

describe("accountDeletionEmail", () => {
  it("returns the deletion subject and branded verify CTA with no financial content", () => {
    const { subject, html } = accountDeletionEmail({
      displayName: "Ada Lovelace",
      verifyLink: "https://app.example.com/delete-account/verify?token=abc",
    });
    expect(subject).toBe(ACCOUNT_DELETION_SUBJECT);
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("https://app.example.com/delete-account/verify?token=abc");
    expect(html).toContain("Confirm account deletion");
    expect(html).toContain("#CC272E");
    expect(html).toContain("permanently delete");
    expect(html).toContain("change your Google password");
    expect(html).toContain("do not confirm");
    expect(html).not.toContain("ignore this email");
    expect(html).toContain("PocketCircle · account deletion");
    expect(html).toContain("— The PocketCircle team");
    expect(html.indexOf("expires in 24 hours")).toBeLessThan(
      html.indexOf('">Confirm account deletion</a>'),
    );
    expect(html).not.toMatch(FINANCIAL_PATTERN);
  });

  it("escapes displayName and verifyLink HTML entities", () => {
    const { html } = accountDeletionEmail({
      displayName: '<script>alert("x")</script>',
      verifyLink: "https://app.example.com/delete-account/verify?token=a&b",
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&amp;");
  });
});

describe("feedbackEmail", () => {
  it("returns a type-specific subject and branded layout", () => {
    const { subject, html } = feedbackEmail({
      type: "bug",
      message: "Crash on save",
      userEmail: "ada@example.com",
      displayName: "Ada Lovelace",
      appVersion: "0-2-0",
      circleName: "Trip",
      circleRef: "trip-c1",
      submittedAtIso: "2026-06-29T12:00:00Z",
    });
    expect(subject).toBe("PocketCircle feedback: bug");
    expect(html).toContain("Crash on save");
    expect(html).toContain("ada@example.com");
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("0-2-0");
    expect(html).toContain("Trip");
    expect(html).toContain("trip-c1");
    expect(html).toContain(BRAND_PRIMARY);
    expect(html).toContain("PocketCircle · bug feedback");
    expect(html).not.toMatch(FINANCIAL_PATTERN);
  });

  it("includes the logo when appUrl is provided", () => {
    const { html } = feedbackEmail({
      type: "feature",
      message: "Dark mode",
      userEmail: "ada@example.com",
      displayName: "Ada",
      appVersion: "0.1.0",
      submittedAtIso: "2026-06-29T12:00:00.000Z",
      appUrl: "https://app.example.com",
    });
    expect(html).toContain("https://app.example.com/logo.png");
    expect(html).toContain("PocketCircle · feature feedback");
  });
});

describe("EMAIL_PREVIEWS", () => {
  it.each(EMAIL_PREVIEWS)(
    "$name render(defaults) returns non-empty subject and html",
    (preview) => {
      const defaults = Object.fromEntries(preview.fields.map((f) => [f.key, f.default]));
      const { subject, html } = preview.render(defaults);
      expect(subject.length).toBeGreaterThan(0);
      expect(html.length).toBeGreaterThan(0);
      for (const field of preview.fields) {
        expect(html).toContain(field.default);
      }
    },
  );
});
