/**
 * Lock-screen-safe Push copy and TTL (ADR 0033 / issue #382).
 * Titles are the settled event-type strings; bodies never name entities.
 */

/** Normal activity Push TTL — 24 hours. */
export const PUSH_ACTIVITY_TTL_SECONDS = 24 * 60 * 60;

const INVITATION_PUSH_TYPES = new Set([
  "invitation.received",
  "invitation.resent",
  "invitation.expiring_soon",
  "invitation.expiring_tomorrow",
  "invitation.accepted",
  "invitation.revoked",
]);

/** Event-type Push title — never free-form NC text that could include names. */
export function pushTitleForNotificationType(type: string) {
  switch (type) {
    case "invitation.received":
      return "Circle invitation";
    case "invitation.resent":
      return "Invitation resent";
    case "invitation.expiring_soon":
      return "Invitation expires in 3 days";
    case "invitation.expiring_tomorrow":
      return "Invitation expires in 1 day";
    case "invitation.accepted":
      return "Invitation accepted";
    case "invitation.revoked":
      return "Invitation revoked";
    case "member.removed":
      return "Removed from Circle";
    case "ownership.transferred":
      return "Ownership transferred";
    case "circle.archived":
      return "Circle archived";
    case "circle.restored":
      return "Circle restored";
    case "transaction.paid_by":
      return "Paid By updated";
    case "transaction.archived":
      return "Transaction archived";
    case "transaction.restored":
      return "Transaction restored";
    case "category.archived":
      return "Category archived";
    case "category.restored":
      return "Category restored";
    default:
      return "PocketCircle";
  }
}

/** Generic Push body for a Notification Center type — no Member/Circle/txn/Category names. */
export function pushBodyForNotificationType(type: string) {
  switch (type) {
    case "invitation.received":
    case "invitation.resent":
      return "Open PocketCircle to view this invitation.";
    case "invitation.expiring_soon":
    case "invitation.expiring_tomorrow":
      return "Open PocketCircle to respond before this invitation expires.";
    case "invitation.accepted":
      return "Open PocketCircle to see who joined.";
    case "invitation.revoked":
      return "Open PocketCircle for invitation details.";
    case "member.removed":
      return "Open PocketCircle for membership details.";
    case "ownership.transferred":
      return "Open PocketCircle for ownership details.";
    case "circle.archived":
    case "circle.restored":
      return "Open PocketCircle for Circle updates.";
    case "transaction.paid_by":
    case "transaction.archived":
    case "transaction.restored":
      return "Open PocketCircle for Transaction updates.";
    case "category.archived":
    case "category.restored":
      return "Open PocketCircle for Category updates.";
    default:
      return "Open PocketCircle for details.";
  }
}

export function isInvitationPushType(type: string) {
  return INVITATION_PUSH_TYPES.has(type);
}

/**
 * TTL in seconds for the push service.
 * Activity: remaining of the 24h window from `createdAtMs` (NC row time). Omit
 * `createdAtMs` only when the event is "now" — pause/resume must pass it so a
 * long pause cannot mint a fresh 24h on the wire.
 * Invitation: remaining until deadline; unknown/past → 0 (skip).
 */
export function pushTtlSeconds(args: {
  type: string;
  nowMs: number;
  invitationExpiresAtMs?: number;
  /** Activity expiry anchor — Notification Center `_creationTime`. */
  createdAtMs?: number;
}) {
  if (!isInvitationPushType(args.type)) {
    const createdAtMs = args.createdAtMs ?? args.nowMs;
    return Math.max(
      0,
      Math.floor((createdAtMs + PUSH_ACTIVITY_TTL_SECONDS * 1000 - args.nowMs) / 1000),
    );
  }
  const expiresAt = args.invitationExpiresAtMs;
  // Spec: Invitation Push must not outlive the invitation. Unknown deadline →
  // skip send (TTL 0) rather than fall back to the 24h activity window.
  if (expiresAt === undefined) {
    return 0;
  }
  const remainingSeconds = Math.floor((expiresAt - args.nowMs) / 1000);
  if (remainingSeconds <= 0) {
    return 0;
  }
  return remainingSeconds;
}
