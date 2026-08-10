import type { FeedbackType } from "./validation.js";

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export const WELCOME_SUBJECT = "Welcome to Spend Circle";
export const INVITATION_SUBJECT = "You're invited to join a Spend Circle";
export const ACCOUNT_DELETION_SUBJECT = "Confirm account deletion";

/** Pure HTML builder — no financial content (PRD 84). */
export function welcomeEmail(args: { displayName: string }) {
  const { displayName } = args;
  return {
    subject: WELCOME_SUBJECT,
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${WELCOME_SUBJECT}</title></head>
<body>
  <p>Hi ${escapeHtml(displayName)},</p>
  <p>Welcome to Spend Circle — a simple way to track shared spending with the people you trust.</p>
  <p>Your Personal Circle is ready. Open the app to finish setting up your profile and start organizing expenses together.</p>
  <p>— The Spend Circle team</p>
</body>
</html>`,
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
  return {
    subject: INVITATION_SUBJECT,
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${INVITATION_SUBJECT}</title></head>
<body>
  <p>Hi ${escapeHtml(recipientEmail)},</p>
  <p>${escapeHtml(ownerDisplayName)} has invited you to join the <strong>${escapeHtml(circleName)}</strong> Circle on Spend Circle.</p>
  <p><a href="${escapeHtml(inviteLink)}">Accept the invitation</a></p>
  <p>This link expires in 7 days and can only be used once.</p>
  <p>— The Spend Circle team</p>
</body>
</html>`,
  };
}

/** Pure HTML builder — no financial content (PRD 84). */
export function accountDeletionEmail(args: { displayName: string; verifyLink: string }) {
  const { displayName, verifyLink } = args;
  return {
    subject: ACCOUNT_DELETION_SUBJECT,
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${ACCOUNT_DELETION_SUBJECT}</title></head>
<body>
  <p>Hi ${escapeHtml(displayName)},</p>
  <p>We received a request to permanently delete your Spend Circle account.</p>
  <p><a href="${escapeHtml(verifyLink)}">Confirm account deletion</a></p>
  <p>This link expires in 24 hours. If you did not request this, you can ignore this email.</p>
  <p>— The Spend Circle team</p>
</body>
</html>`,
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
}) {
  const typeLabel = FEEDBACK_TYPE_LABEL[args.type];
  const subject = `Spend Circle feedback: ${typeLabel}`;
  const circleBlock =
    args.circleName && args.circleRef
      ? `<p><strong>Circle:</strong> ${escapeHtml(args.circleName)} (${escapeHtml(args.circleRef)})</p>`
      : "";
  return {
    subject,
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body>
  <p><strong>Type:</strong> ${escapeHtml(typeLabel)}</p>
  <p><strong>From:</strong> ${escapeHtml(args.displayName)} &lt;${escapeHtml(args.userEmail)}&gt;</p>
  <p><strong>App version:</strong> ${escapeHtml(args.appVersion)}</p>
  <p><strong>Submitted:</strong> ${escapeHtml(args.submittedAtIso)}</p>
  ${circleBlock}
  <p><strong>Message:</strong></p>
  <p>${escapeHtml(args.message).replaceAll("\n", "<br>")}</p>
</body>
</html>`,
  };
}

/** One source of truth for the preview UI and the template tests — no per-file drift. */
export const EMAIL_PREVIEWS = [
  {
    id: "welcome",
    name: "Welcome",
    fields: [{ key: "displayName", label: "Display name", default: "Ada Lovelace" }],
    render: (p: Record<string, string>) => welcomeEmail({ displayName: p.displayName ?? "" }),
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
      }),
  },
] as const;
