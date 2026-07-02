import { describe, expect, it } from "vitest";
import {
  buildCategoryNotificationLink,
  buildCircleNotificationLink,
  buildTransactionNotificationLink,
  parseNotificationLinkPath,
} from "./notification-links.js";

const isValidId = (candidate: string) => /^[a-z0-9]{2,}$/.test(candidate);

describe("notification link builders", () => {
  it("builds the three canonical path shapes", () => {
    expect(buildCircleNotificationLink("trip-c1abc")).toBe("/circles/trip-c1abc");
    expect(buildTransactionNotificationLink("trip-c1abc", "weekly-t1abc")).toBe(
      "/circles/trip-c1abc/transactions/weekly-t1abc",
    );
    expect(buildCategoryNotificationLink("trip-c1abc", "groceries-cat1")).toBe(
      "/circles/trip-c1abc/categories/groceries-cat1",
    );
  });
});

describe("parseNotificationLinkPath", () => {
  it("parses circle, transaction, and category links", () => {
    expect(parseNotificationLinkPath("/circles/trip-c1abc", isValidId)).toEqual({
      kind: "circle",
      circleRef: "trip-c1abc",
      circleId: "c1abc",
    });
    expect(
      parseNotificationLinkPath("/circles/trip-c1abc/transactions/weekly-t1abc", isValidId),
    ).toEqual({
      kind: "transaction",
      circleRef: "trip-c1abc",
      circleId: "c1abc",
      objectRef: "weekly-t1abc",
      objectId: "t1abc",
    });
    expect(
      parseNotificationLinkPath("/circles/trip-c1abc/categories/groceries-cat1", isValidId),
    ).toEqual({
      kind: "category",
      circleRef: "trip-c1abc",
      circleId: "c1abc",
      objectRef: "groceries-cat1",
      objectId: "cat1",
    });
  });

  it("rejects malformed paths", () => {
    expect(parseNotificationLinkPath("/settings", isValidId)).toBeNull();
    expect(parseNotificationLinkPath("/circles/trip-c1abc/unknown/x", isValidId)).toBeNull();
    expect(parseNotificationLinkPath("/circles/trip-c1abc/transactions", isValidId)).toBeNull();
    expect(
      parseNotificationLinkPath(
        "/circles/trip-c1abc/categories?categoryRef=groceries-cat1",
        isValidId,
      ),
    ).toBeNull();
    expect(parseNotificationLinkPath("/circles/trip-c1abc/categories", isValidId)).toBeNull();
    expect(parseNotificationLinkPath("/circles/!", isValidId)).toBeNull();
  });
});
