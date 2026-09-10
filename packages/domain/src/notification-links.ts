import { type IdValidator, parseRef } from "./ref.js";

/** Canonical in-app notification link shapes (NTF-1 / NTF-2 / #375 contract). */
export type NotificationLinkKind = "circle" | "transaction" | "category" | "invitation";

export type ParsedNotificationLink =
  | {
      kind: "circle";
      circleRef: string;
      circleId: string;
    }
  | {
      kind: "transaction" | "category";
      circleRef: string;
      circleId: string;
      objectRef: string;
      objectId: string;
    }
  | {
      kind: "invitation";
      invitationRef: string;
      invitationId: string;
    };

export function buildCircleNotificationLink(circleRef: string) {
  return `/circles/${circleRef}`;
}

export function buildTransactionNotificationLink(circleRef: string, transactionRef: string) {
  return `/circles/${circleRef}/transactions/${transactionRef}`;
}

export function buildCategoryNotificationLink(circleRef: string, categoryRef: string) {
  return `/circles/${circleRef}/categories/${categoryRef}`;
}

/** Authenticated Invitation acceptance path — Invitation identity only, never the emailed token. */
export function buildInvitationNotificationLink(invitationRef: string) {
  return `/invitations/${invitationRef}`;
}

/**
 * Parses a stored notification `link` path. Returns `null` when the shape does not
 * match one of the canonical forms — callers treat that as text-only (ADR 0016).
 */
export function parseNotificationLinkPath(
  link: string,
  isValidId: IdValidator,
): ParsedNotificationLink | null {
  const path = link.split("?")[0] ?? link;

  const parts = path.split("/");
  if (parts.length < 3 || parts[0] !== "") {
    return null;
  }

  if (parts[1] === "invitations") {
    if (parts.length !== 3) {
      return null;
    }
    const invitationRef = parts[2];
    if (!invitationRef) {
      return null;
    }
    const invitationParsed = parseRef(invitationRef, isValidId);
    if (!invitationParsed) {
      return null;
    }
    return {
      kind: "invitation",
      invitationRef,
      invitationId: invitationParsed.id,
    };
  }

  if (parts[1] !== "circles") {
    return null;
  }
  const circleRef = parts[2];
  if (!circleRef) {
    return null;
  }
  const circleParsed = parseRef(circleRef, isValidId);
  if (!circleParsed) {
    return null;
  }

  if (parts.length === 3) {
    return { kind: "circle", circleRef, circleId: circleParsed.id };
  }

  if (parts.length !== 5) {
    return null;
  }

  const segment = parts[3];
  const objectRef = parts[4];
  if (!objectRef) {
    return null;
  }
  const objectParsed = parseRef(objectRef, isValidId);
  if (!objectParsed) {
    return null;
  }

  if (segment === "transactions") {
    return {
      kind: "transaction",
      circleRef,
      circleId: circleParsed.id,
      objectRef,
      objectId: objectParsed.id,
    };
  }

  if (segment === "categories") {
    return {
      kind: "category",
      circleRef,
      circleId: circleParsed.id,
      objectRef,
      objectId: objectParsed.id,
    };
  }

  return null;
}
