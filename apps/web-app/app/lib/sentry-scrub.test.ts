import { buildRef } from "@pocketcircle/domain";
import { describe, expect, it } from "vitest";
import {
  scrubAppErrorExtra,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubUrlForSentry,
} from "./sentry-scrub.js";

const txnRef = buildRef("Weekly grocery shop", "t1abc");
const circleRef = buildRef("Family Trip", "c1abc");

describe("scrubUrlForSentry", () => {
  it("redacts title-bearing transaction and circle refs in the path", () => {
    const scrubbed = scrubUrlForSentry(
      `http://127.0.0.1:5173/circles/${circleRef}/transactions/${txnRef}/edit`,
    );

    expect(scrubbed).not.toContain("weekly-grocery-shop");
    expect(scrubbed).not.toContain("family-trip");
    expect(scrubbed).toContain("/circles/c1abc/transactions/t1abc/");
  });

  it("keeps static route segments intact", () => {
    expect(scrubUrlForSentry("/circles/c1abc/transactions/new")).toBe(
      "/circles/c1abc/transactions/new",
    );
  });

  it("scrubs returnTo and drops user-entered search text from query strings", () => {
    const origin = `/circles/${circleRef}/transactions?type=expense&status=all&q=grocery`;
    const scrubbed = scrubUrlForSentry(
      `/circles/${circleRef}/transactions/${txnRef}/edit?returnTo=${encodeURIComponent(origin)}`,
    );

    expect(scrubbed).not.toContain("weekly-grocery-shop");
    expect(scrubbed).not.toContain("family-trip");
    expect(scrubbed).not.toContain("grocery");
    expect(scrubbed).toContain("returnTo=");
    expect(scrubbed).toContain("%2Fcircles%2Fc1abc%2Ftransactions");
    expect(scrubbed).toContain("type%3Dexpense");
    expect(scrubbed).toContain("status%3Dall");
    expect(scrubbed).not.toContain("q%3D");
  });

  it("redacts categoryRef and category filter refs in query strings", () => {
    const groceriesRef = buildRef("Groceries", "cat1");
    const scrubbed = scrubUrlForSentry(
      `/circles/${circleRef}/categories?categoryRef=${groceriesRef}&categories=${groceriesRef},${buildRef("Rent", "cat2")}`,
    );

    expect(scrubbed).not.toContain("groceries");
    expect(scrubbed).not.toContain("rent");
    expect(scrubbed).toContain("categoryRef=cat1");
    expect(scrubbed).toContain("categories=cat1%2Ccat2");
  });

  it("drops amount filters and hash fragments from telemetry URLs", () => {
    const scrubbed = scrubUrlForSentry(
      `/circles/${circleRef}/search?q=rent&min=10.50&max=99.99#results`,
    );

    expect(scrubbed).not.toContain("rent");
    expect(scrubbed).not.toContain("10.50");
    expect(scrubbed).not.toContain("99.99");
    expect(scrubbed).not.toContain("#");
    expect(scrubbed).toBe(`/circles/c1abc/search`);
  });
});

describe("scrubAppErrorExtra", () => {
  it("redacts rawRef slugs and drops financial keys", () => {
    expect(
      scrubAppErrorExtra({
        rawRef: txnRef,
        title: "Weekly grocery shop",
        amountMinorUnits: 1299,
      }),
    ).toEqual({
      rawRef: "t1abc",
    });
  });

  it("redacts unparseable hyphenated rawRef values", () => {
    expect(scrubAppErrorExtra({ rawRef: "grocery-shopping-bad!" })).toEqual({
      rawRef: "[unparseable-ref]",
    });
  });
});

describe("scrubSentryEvent", () => {
  it("scrubs request URLs, breadcrumbs, and extras before send", () => {
    const origin = `/circles/${circleRef}/transactions?month=2026-05&q=grocery`;
    const event = {
      type: undefined,
      request: {
        url: `http://127.0.0.1:5173/circles/${circleRef}/transactions/${txnRef}/edit?returnTo=${encodeURIComponent(origin)}`,
      },
      breadcrumbs: [
        {
          category: "navigation",
          data: {
            from: `/circles/${circleRef}?q=food`,
            to: `/circles/${circleRef}/transactions/${txnRef}`,
          },
        },
      ],
      extra: { rawRef: txnRef, note: "paid in cash" },
    };

    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed.request?.url).not.toContain("weekly-grocery-shop");
    expect(scrubbed.request?.url).not.toContain("family-trip");
    expect(scrubbed.request?.url).not.toContain("grocery");
    expect(scrubbed.request?.url).toContain("/circles/c1abc/transactions/t1abc");
    expect(scrubbed.request?.url).toContain("returnTo=");
    expect(scrubbed.breadcrumbs?.[0]?.data?.from).toBe("/circles/c1abc");
    expect(scrubbed.breadcrumbs?.[0]?.data?.to).toBe("/circles/c1abc/transactions/t1abc");
    expect(scrubbed.extra).toEqual({ rawRef: "t1abc" });
  });
});

describe("scrubSentryBreadcrumb", () => {
  it("scrubs navigation breadcrumb URLs", () => {
    const scrubbed = scrubSentryBreadcrumb({
      category: "navigation",
      data: { to: `/circles/${circleRef}/transactions/${txnRef}` },
    });

    expect(scrubbed.data?.to).toBe("/circles/c1abc/transactions/t1abc");
  });
});
