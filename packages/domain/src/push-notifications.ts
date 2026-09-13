/**
 * Lock-screen-safe Push copy and TTL (ADR 0033 / issue #382).
 * Titles match Notification Center event titles; bodies never name entities.
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
 * TTL in seconds for the push service. Activity = 24h. Invitation types with a
 * known deadline use remaining time until that deadline (never longer than the
 * invitation lives). Missing/expired deadline falls back to activity TTL.
 */
export function pushTtlSeconds(args: {
  type: string;
  nowMs: number;
  invitationExpiresAtMs?: number;
}) {
  if (!isInvitationPushType(args.type)) {
    return PUSH_ACTIVITY_TTL_SECONDS;
  }
  const expiresAt = args.invitationExpiresAtMs;
  if (expiresAt === undefined) {
    return PUSH_ACTIVITY_TTL_SECONDS;
  }
  const remainingSeconds = Math.floor((expiresAt - args.nowMs) / 1000);
  if (remainingSeconds <= 0) {
    return 0;
  }
  return remainingSeconds;
}
