import { describe, expect, it } from "vitest";
import {
  ACCOUNT_DELETION_SUBJECT,
  accountDeletionEmail,
  EMAIL_PREVIEWS,
  feedbackEmail,
  INVITATION_SUBJECT,
  invitationEmail,
  WELCOME_SUBJECT,
  welcomeEmail,
} from "./email-templates.js";

const FINANCIAL_PATTERN = /\$|\bUSD\b|\bEUR\b|\bGBP\b|\bamount\b|\bbalance\b|\d+\.\d{2}/i;
const IMAGE_PATTERN = /\b(img|avatar|ownerImage|image)\b/i;

describe("welcomeEmail", () => {
  it("returns the welcome subject and HTML with the display name", () => {
    const { subject, html } = welcomeEmail({ displayName: "Ada Lovelace" });
    expect(subject).toBe(WELCOME_SUBJECT);
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Welcome to PocketCircle");
    expect(html).toContain("Personal Circle");
    expect(html).not.toMatch(FINANCIAL_PATTERN);
  });
});

describe("invitationEmail", () => {
  it("returns the invitation subject and interpolated, escaped values with no financial content", () => {
    const { subject, html } = invitationEmail({
      inviteLink: "https://app.example.com/invite/abc123",
      circleName: "Trip",
      ownerDisplayName: "Olive Owner",
      recipientEmail: "ada@example.com",
    });
    expect(subject).toBe(INVITATION_SUBJECT);
    expect(html).toContain("ada@example.com");
    expect(html).toContain("Olive Owner");
    expect(html).toContain("Trip");
    expect(html).toContain("https://app.example.com/invite/abc123");
    expect(html).toContain("expires in 7 days");
    expect(html).not.toMatch(FINANCIAL_PATTERN);
    expect(html).not.toMatch(IMAGE_PATTERN);
  });

  it("escapes HTML-special chars in interpolated values", () => {
    const { html } = invitationEmail({
      inviteLink: "https://app.example.com/invite/tok",
      circleName: "<script>",
      ownerDisplayName: 'O"wn',
      recipientEmail: "a&b@example.com",
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("a&amp;b@example.com");
    expect(html).toContain("O&quot;wn");
  });
});

describe("accountDeletionEmail", () => {
  it("returns the deletion subject and verify link with no financial content", () => {
    const { subject, html } = accountDeletionEmail({
      displayName: "Ada Lovelace",
      verifyLink: "https://app.example.com/delete-account/verify?token=abc",
    });
    expect(subject).toBe(ACCOUNT_DELETION_SUBJECT);
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("https://app.example.com/delete-account/verify?token=abc");
    expect(html).toContain("permanently delete");
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
  it("returns a type-specific subject and interpolated values", () => {
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
    expect(html).not.toMatch(FINANCIAL_PATTERN);
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
