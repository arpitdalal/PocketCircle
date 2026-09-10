import type { FeedbackType } from "./validation.js";

/** Email-safe hex mirrors of web-app brand tokens (oklch → sRGB). */
export const EMAIL_BRAND = {
  canvas: "#F8F7FB",
  card: "#FFFFFF",
  text: "#231F2F",
  muted: "#646073",
  primary: "#7C47D9",
  primaryFg: "#FFFFFF",
  border: "#DBD9E4",
  danger: "#CC272E",
} as const;

const BRAND = EMAIL_BRAND;

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function assetUrl(baseUrl: string, path: string) {
  try {
    return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href;
  } catch {
    return undefined;
  }
}

function originFromUrl(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function ctaButton(href: string, label: string, tone: "primary" | "danger" = "primary") {
  const bg = tone === "danger" ? BRAND.danger : BRAND.primary;
  return `<a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 20px;background-color:${bg};color:${BRAND.primaryFg};text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;line-height:1.2;font-family:${FONT}">${escapeHtml(label)}</a>`;
}

const TEAM_SIGNATURE = `<p style="margin:0;color:${BRAND.muted}">— The PocketCircle team</p>`;
const DEFAULT_FOOTER = "PocketCircle · a place for your spending, and the spending you share";

function emailDocument(args: {
  title: string;
  preheader?: string;
  bodyHtml: string;
  logoSrc?: string;
  footer?: string;
}) {
  const preheader = args.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${BRAND.canvas}" aria-hidden="true">${escapeHtml(args.preheader)}</div>`
    : "";
  const mark = args.logoSrc
    ? `<img src="${escapeHtml(args.logoSrc)}" width="36" height="36" alt="" style="display:block;border:0;border-radius:9px;outline:none" />`
    : `<span style="display:inline-block;width:36px;height:36px;border-radius:9px;background-color:${BRAND.primary}"></span>`;
  const footer = args.footer ?? DEFAULT_FOOTER;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="x-ua-compatible" content="ie=edge">
<title>${escapeHtml(args.title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.canvas};">
${preheader}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:${BRAND.canvas};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background-color:${BRAND.card};border:1px solid ${BRAND.border};border-radius:12px;overflow:hidden;">
        <tr>
          <td style="padding:24px 28px;border-bottom:1px solid ${BRAND.border};background-color:${BRAND.card};">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td style="vertical-align:middle;padding-right:12px;">${mark}</td>
                <td style="vertical-align:middle;font-family:${FONT};font-size:17px;font-weight:700;color:${BRAND.text};">PocketCircle</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:28px;font-family:${FONT};font-size:16px;line-height:1.5;color:${BRAND.text};">
            ${args.bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:18px 28px 24px;border-top:1px solid ${BRAND.border};font-family:${FONT};font-size:13px;line-height:1.4;color:${BRAND.muted};">
            ${escapeHtml(footer)}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

export const WELCOME_SUBJECT = "Welcome to PocketCircle";
export const ACCOUNT_DELETION_SUBJECT = "Confirm account deletion";

export function invitationSubject(circleName: string) {
  return `You're invited to join ${circleName} on PocketCircle`;
}

/** Pure HTML builder — no financial content (PRD 84). */
export function welcomeEmail(args: { displayName: string; appUrl: string }) {
  const { displayName, appUrl } = args;
  const bodyHtml = `
<p style="margin:0 0 16px">Hi ${escapeHtml(displayName)},</p>
<p style="margin:0 0 16px">Welcome to PocketCircle.</p>
<p style="margin:0 0 16px">Your Personal Circle is ready for tracking your own expenses. For spending with a partner, family, or roommates, create a separate Circle and invite them to join.</p>
<p style="margin:0 0 24px">Start with something simple, like today’s coffee or groceries.</p>
<p style="margin:0 0 24px">${ctaButton(appUrl, "Open PocketCircle")}</p>
${TEAM_SIGNATURE}`;

  return {
    subject: WELCOME_SUBJECT,
    html: emailDocument({
      title: WELCOME_SUBJECT,
      preheader: "A place for your spending, and the spending you share.",
      bodyHtml,
      logoSrc: assetUrl(appUrl, "logo.png"),
    }),
  };
}

/** Pure HTML builder — no financial content (PRD 84). */
export function invitationEmail(args: {
  inviteLink: string;
  circleName: string;
  ownerDisplayName: string;
  recipientEmail: string;
}) {
  const { inviteLink, circleName, ownerDisplayName, recipientEmail } = args;
  const subject = invitationSubject(circleName);
  const origin = originFromUrl(inviteLink);
  const bodyHtml = `
<p style="margin:0 0 16px">Hi ${escapeHtml(recipientEmail)},</p>
<p style="margin:0 0 16px">${escapeHtml(ownerDisplayName)} has invited you to join the <strong>${escapeHtml(circleName)}</strong> Circle on PocketCircle.</p>
<p style="margin:0 0 24px">This link expires in 7 days and can only be used once.</p>
<p style="margin:0 0 24px">${ctaButton(inviteLink, `Accept invitation to ${circleName}`)}</p>
${TEAM_SIGNATURE}`;

  return {
    subject,
    html: emailDocument({
      title: subject,
      preheader: `${ownerDisplayName} invited you to ${circleName}.`,
      bodyHtml,
      logoSrc: origin ? assetUrl(origin, "logo.png") : undefined,
      // Circle-specific trailing line — keeps Gmail from hiding the CTA in threaded invites (#376).
      footer: `PocketCircle · invitation to ${circleName}`,
    }),
  };
}

/** Pure HTML builder — no financial content (PRD 84). */
export function accountDeletionEmail(args: { displayName: string; verifyLink: string }) {
  const { displayName, verifyLink } = args;
  const origin = originFromUrl(verifyLink);
  const bodyHtml = `
<p style="margin:0 0 16px">Hi ${escapeHtml(displayName)},</p>
<p style="margin:0 0 16px">We received a request to permanently delete your PocketCircle account.</p>
<p style="margin:0 0 16px">This link expires in 24 hours.</p>
<p style="margin:0 0 24px">If you did not request this, do not confirm. Someone may have signed in as you — change your Google password and review recent Google account activity, then disregard this email.</p>
<p style="margin:0 0 24px">${ctaButton(verifyLink, "Confirm account deletion", "danger")}</p>
${TEAM_SIGNATURE}`;

  return {
    subject: ACCOUNT_DELETION_SUBJECT,
    html: emailDocument({
      title: ACCOUNT_DELETION_SUBJECT,
      preheader: "Confirm to permanently delete your PocketCircle account.",
      bodyHtml,
      logoSrc: origin ? assetUrl(origin, "logo.png") : undefined,
      footer: "PocketCircle · account deletion",
    }),
  };
}

const FEEDBACK_TYPE_LABEL: Record<FeedbackType, string> = {
  bug: "bug",
  feature: "feature",
  currency: "currency",
};

/** Pure HTML builder for in-app feedback (FBK-1) — escapes all user-supplied values. */
export function feedbackEmail(args: {
  type: FeedbackType;
  message: string;
  userEmail: string;
  displayName: string;
  appVersion: string;
  circleName?: string;
  circleRef?: string;
  submittedAtIso: string;
  appUrl?: string;
}) {
  const typeLabel = FEEDBACK_TYPE_LABEL[args.type];
  const subject = `PocketCircle feedback: ${typeLabel}`;
  const circleBlock =
    args.circleName && args.circleRef
      ? `<p style="margin:0 0 12px"><strong>Circle:</strong> ${escapeHtml(args.circleName)} (${escapeHtml(args.circleRef)})</p>`
      : "";
  const bodyHtml = `
<p style="margin:0 0 12px"><strong>Type:</strong> ${escapeHtml(typeLabel)}</p>
<p style="margin:0 0 12px"><strong>From:</strong> ${escapeHtml(args.displayName)} &lt;${escapeHtml(args.userEmail)}&gt;</p>
<p style="margin:0 0 12px"><strong>App version:</strong> ${escapeHtml(args.appVersion)}</p>
<p style="margin:0 0 12px"><strong>Submitted:</strong> ${escapeHtml(args.submittedAtIso)}</p>
${circleBlock}
<p style="margin:16px 0 8px"><strong>Message:</strong></p>
<p style="margin:0;padding:14px 16px;background-color:${BRAND.canvas};border:1px solid ${BRAND.border};border-radius:8px;white-space:pre-wrap">${escapeHtml(args.message).replaceAll("\n", "<br>")}</p>`;

  return {
    subject,
    html: emailDocument({
      title: subject,
      bodyHtml,
      logoSrc: args.appUrl ? assetUrl(args.appUrl, "logo.png") : undefined,
      footer: `PocketCircle · ${typeLabel} feedback`,
    }),
  };
}

/** One source of truth for the preview UI and the template tests — no per-file drift. */
export const EMAIL_PREVIEWS = [
  {
    id: "welcome",
    name: "Welcome",
    fields: [
      { key: "displayName", label: "Display name", default: "Ada Lovelace" },
      { key: "appUrl", label: "App URL", default: "https://app.example.com" },
    ],
    render: (p: Record<string, string>) =>
      welcomeEmail({ displayName: p.displayName ?? "", appUrl: p.appUrl ?? "" }),
  },
  {
    id: "invitation",
    name: "Invitation",
    fields: [
      { key: "circleName", label: "Circle name", default: "Weekend Trip" },
      { key: "ownerDisplayName", label: "Owner", default: "Ada Lovelace" },
      { key: "recipientEmail", label: "Recipient", default: "grace@example.com" },
      {
        key: "inviteLink",
        label: "Invite link",
        default: "https://app.example.com/invite/sample-token",
      },
    ],
    render: (p: Record<string, string>) =>
      invitationEmail({
        inviteLink: p.inviteLink ?? "",
        circleName: p.circleName ?? "",
        ownerDisplayName: p.ownerDisplayName ?? "",
        recipientEmail: p.recipientEmail ?? "",
      }),
  },
  {
    id: "accountDeletion",
    name: "Account deletion",
    fields: [
      { key: "displayName", label: "Display name", default: "Ada Lovelace" },
      {
        key: "verifyLink",
        label: "Verify link",
        default: "https://app.example.com/delete-account/verify?token=sample-token",
      },
    ],
    render: (p: Record<string, string>) =>
      accountDeletionEmail({
        displayName: p.displayName ?? "",
        verifyLink: p.verifyLink ?? "",
      }),
  },
  {
    id: "feedback",
    name: "Feedback",
    fields: [
      { key: "type", label: "Type", default: "bug" },
      { key: "message", label: "Message", default: "The dashboard feels slow on mobile." },
      { key: "userEmail", label: "User email", default: "ada@example.com" },
      { key: "displayName", label: "Display name", default: "Ada Lovelace" },
      { key: "appVersion", label: "App version", default: "0.1.0" },
      { key: "circleName", label: "Circle name", default: "Weekend Trip" },
      { key: "circleRef", label: "Circle ref", default: "weekend-trip-c1" },
      {
        key: "submittedAtIso",
        label: "Submitted at",
        default: "2026-06-29T12:00:00.000Z",
      },
      { key: "appUrl", label: "App URL", default: "https://app.example.com" },
    ],
    render: (p: Record<string, string>) =>
      feedbackEmail({
        type: p.type === "feature" || p.type === "currency" ? p.type : "bug",
        message: p.message ?? "",
        userEmail: p.userEmail ?? "",
        displayName: p.displayName ?? "",
        appVersion: p.appVersion ?? "",
        circleName: p.circleName,
        circleRef: p.circleRef,
        submittedAtIso: p.submittedAtIso ?? "",
        appUrl: p.appUrl,
      }),
  },
] as const;
