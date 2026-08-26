import { describe, expect, it } from "vitest";
import { FEATURE_ANNOUNCEMENT_IDS, isFeatureAnnouncementId } from "./feature-announcements.js";

describe("isFeatureAnnouncementId", () => {
  it("accepts every registered ID", () => {
    for (const id of FEATURE_ANNOUNCEMENT_IDS) {
      expect(isFeatureAnnouncementId(id)).toBe(true);
    }
  });

  it("rejects unknown IDs", () => {
    expect(isFeatureAnnouncementId("unknown")).toBe(false);
    expect(isFeatureAnnouncementId("")).toBe(false);
    expect(isFeatureAnnouncementId("duplicate_transaction")).toBe(false);
  });
});
