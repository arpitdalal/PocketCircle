import { describe, expect, it } from "vitest";
import {
  buildPushNotificationClickPath,
  isPushNotificationClickReturnTo,
  isSafePushResolvedPath,
  PUSH_NOTIFICATION_CLICK_MESSAGE_TYPE,
  PUSH_NOTIFICATION_CLICK_PARAM,
  PUSH_NOTIFICATION_CLICK_PATH,
  parsePushNotificationClickMessage,
  parsePushNotificationClickSearch,
  parsePushNotificationId,
} from "./push-notification-click.js";

const acceptAllIds = () => true;

describe("push notification click protocol", () => {
  it("builds a same-origin deep link from Notification identity only", () => {
    expect(buildPushNotificationClickPath("jd7abc123")).toBe(
      `${PUSH_NOTIFICATION_CLICK_PATH}?${PUSH_NOTIFICATION_CLICK_PARAM}=jd7abc123`,
    );
  });

  it("rejects malformed identities instead of embedding them in the path", () => {
    expect(buildPushNotificationClickPath("../evil")).toBe("/");
    expect(buildPushNotificationClickPath("https://evil.example/x")).toBe("/");
    expect(buildPushNotificationClickPath("")).toBe("/");
    expect(parsePushNotificationId("a/b")).toBeNull();
    expect(parsePushNotificationId("a?b=1")).toBeNull();
  });

  it("parses the deep-link query and ignores other params for identity", () => {
    expect(parsePushNotificationClickSearch(`?${PUSH_NOTIFICATION_CLICK_PARAM}=jd7abc123`)).toBe(
      "jd7abc123",
    );
    expect(parsePushNotificationClickSearch("?n=bad/id")).toBeNull();
    expect(parsePushNotificationClickSearch("")).toBeNull();
  });

  it("narrows service-worker messages to Notification identity", () => {
    expect(
      parsePushNotificationClickMessage({
        type: PUSH_NOTIFICATION_CLICK_MESSAGE_TYPE,
        notificationId: "jd7abc123",
      }),
    ).toEqual({
      type: PUSH_NOTIFICATION_CLICK_MESSAGE_TYPE,
      notificationId: "jd7abc123",
    });
    expect(
      parsePushNotificationClickMessage({
        type: PUSH_NOTIFICATION_CLICK_MESSAGE_TYPE,
        notificationId: "/circles/trip-c1",
      }),
    ).toBeNull();
    expect(
      parsePushNotificationClickMessage({
        type: PUSH_NOTIFICATION_CLICK_MESSAGE_TYPE,
        path: "/circles/trip-c1",
      }),
    ).toBeNull();
  });

  it("allows only canonical notification link shapes as resolved destinations", () => {
    expect(isSafePushResolvedPath("/circles/trip-c1", acceptAllIds)).toBe(true);
    expect(isSafePushResolvedPath("/circles/trip-c1/transactions/weekly-t1", acceptAllIds)).toBe(
      true,
    );
    expect(isSafePushResolvedPath("/invitations/trip-inv1", acceptAllIds)).toBe(true);
    expect(isSafePushResolvedPath("/settings", acceptAllIds)).toBe(false);
    expect(isSafePushResolvedPath("//evil.example", acceptAllIds)).toBe(false);
    expect(isSafePushResolvedPath("/circles/trip-c1/../settings", acceptAllIds)).toBe(false);
  });

  it("whitelists Push click returnTo without other query smuggling", () => {
    expect(isPushNotificationClickReturnTo(PUSH_NOTIFICATION_CLICK_PATH)).toBe(true);
    expect(
      isPushNotificationClickReturnTo(
        `${PUSH_NOTIFICATION_CLICK_PATH}?${PUSH_NOTIFICATION_CLICK_PARAM}=jd7abc123`,
      ),
    ).toBe(true);
    expect(
      isPushNotificationClickReturnTo(
        `${PUSH_NOTIFICATION_CLICK_PATH}?${PUSH_NOTIFICATION_CLICK_PARAM}=jd7&returnTo=/settings`,
      ),
    ).toBe(false);
    expect(isPushNotificationClickReturnTo("/settings")).toBe(false);
  });
});
