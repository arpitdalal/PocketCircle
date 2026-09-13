import { describe, expect, it } from "vitest";
import {
  isInvitationPushType,
  PUSH_ACTIVITY_TTL_SECONDS,
  pushBodyForNotificationType,
  pushTtlSeconds,
} from "./push-notifications.js";

describe("push-notifications", () => {
  it("uses generic bodies with no entity names", () => {
    const body = pushBodyForNotificationType("transaction.paid_by");
    expect(body).toBe("Open PocketCircle for Transaction updates.");
    expect(body).not.toMatch(/Ada|Weekly shop|Family/i);
  });

  it("falls back for unknown types", () => {
    expect(pushBodyForNotificationType("future.event")).toBe("Open PocketCircle for details.");
  });

  it("classifies invitation types", () => {
    expect(isInvitationPushType("invitation.received")).toBe(true);
    expect(isInvitationPushType("transaction.archived")).toBe(false);
  });

  it("uses 24h TTL for activity", () => {
    expect(pushTtlSeconds({ type: "circle.archived", nowMs: 1_000_000 })).toBe(
      PUSH_ACTIVITY_TTL_SECONDS,
    );
  });

  it("caps invitation TTL at the deadline", () => {
    const nowMs = 1_000_000;
    const invitationExpiresAtMs = nowMs + 3_600_000;
    expect(
      pushTtlSeconds({
        type: "invitation.received",
        nowMs,
        invitationExpiresAtMs,
      }),
    ).toBe(3600);
  });

  it("returns 0 when the invitation deadline has passed", () => {
    expect(
      pushTtlSeconds({
        type: "invitation.received",
        nowMs: 2_000_000,
        invitationExpiresAtMs: 1_000_000,
      }),
    ).toBe(0);
  });

  it("falls back to 24h when invitation deadline is unknown", () => {
    expect(pushTtlSeconds({ type: "invitation.revoked", nowMs: 1_000_000 })).toBe(
      PUSH_ACTIVITY_TTL_SECONDS,
    );
  });
});
