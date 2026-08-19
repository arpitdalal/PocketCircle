import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RETURN_TO_PARAM, withReturnTo } from "~/lib/return-to-url.js";
import {
  circleLayoutHeadingChrome,
  configureConvex,
  convexReactMock,
  makeCircleView,
  makeCurrentUserView,
  renderCircleRoutes,
} from "~/test/convex-react.js";
import {
  posthogSdk,
  primeAnalyticsForTests,
  resetPostHogBoundary,
} from "~/test/posthog-boundary.js";
import { renderRouteStub } from "~/test/router-stub.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);

import CircleLayout from "../layouts/circle-layout.js";
import CircleFeedback from "./feedback.js";

const REF = "trip-c1";
const DASHBOARD = `/circles/${REF}`;
const ORIGIN = `/circles/${REF}/transactions?month=2026-05`;

const ROUTES = (
  <>
    <Route path="circles/:circleRef" element={<div>dashboard</div>} />
    <Route path="circles/:circleRef/transactions" element={<div>ledger</div>} />
    <Route path="circles/:circleRef/feedback" element={<CircleFeedback />} />
  </>
);

function setup(opts: { url?: string } = {}) {
  const circle = makeCircleView();
  const submitFeedback = vi.fn().mockResolvedValue(undefined);
  configureConvex({
    currentUser: makeCurrentUserView({
      email: "ada@example.com",
      displayName: "Ada Lovelace",
    }),
    submitFeedback,
  });
  const url = opts.url ?? withReturnTo(`/circles/${REF}/feedback`, ORIGIN);
  const view = renderCircleRoutes(circle, ROUTES, {
    initialEntries: [url],
    chrome: circleLayoutHeadingChrome(circle),
  });
  return { ...view, circle, submitFeedback };
}

beforeEach(() => {
  convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
  primeAnalyticsForTests();
});

afterEach(() => {
  resetPostHogBoundary();
  vi.clearAllMocks();
});

describe("Circle Feedback", () => {
  it("shows the resolved Circle name and submits only the internal circleId", async () => {
    const user = userEvent.setup();
    const { circle, submitFeedback } = setup();

    expect((await screen.findByText(/Circle context:/)).closest("p")).toHaveTextContent(
      "Circle context: Trip",
    );
    expect(screen.getByRole("heading", { level: 1, name: "Trip" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Send feedback" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Message"), "Dashboard totals look off");
    await user.click(screen.getByRole("button", { name: "Send feedback" }));

    await waitFor(() => {
      expect(submitFeedback).toHaveBeenCalledWith({
        type: "bug",
        message: "Dashboard totals look off",
        appVersion: __APP_VERSION__,
        circleId: circle.id,
      });
    });
    const args = submitFeedback.mock.calls[0]?.[0];
    expect(args).not.toHaveProperty("circleRef");
    expect(args).not.toHaveProperty("circleName");
    expect(posthogSdk.capture).toHaveBeenCalledWith("feedback_submitted", { type: "bug" });
    expect(posthogSdk.capture.mock.calls[0]?.[1]).toEqual({ type: "bug" });
  });

  it("returns Back to a valid Circle returnTo", () => {
    setup();
    expect(screen.getByRole("link", { name: /Back/ })).toHaveAttribute("href", ORIGIN);
  });

  it("falls back to the Circle Dashboard when returnTo is missing", () => {
    setup({ url: `/circles/${REF}/feedback` });
    expect(screen.getByRole("link", { name: /Back/ })).toHaveAttribute("href", DASHBOARD);
  });

  it("falls back to the Circle Dashboard for an unsafe returnTo", () => {
    setup({
      url: `/circles/${REF}/feedback?${RETURN_TO_PARAM}=${encodeURIComponent("https://evil.com")}`,
    });
    expect(screen.getByRole("link", { name: /Back/ })).toHaveAttribute("href", DASHBOARD);
  });
});

describe("Circle Feedback — Circle guard", () => {
  it("ejects an inaccessible Circle feedback URL through the existing Circle guard", async () => {
    configureConvex({ circle: null, currentUser: makeCurrentUserView() });
    renderRouteStub(
      [
        { path: "/", Component: () => <h2>Home</h2> },
        {
          path: "/circles/:circleRef",
          Component: CircleLayout,
          children: [{ path: "feedback", Component: CircleFeedback }],
        },
      ],
      [`/circles/${REF}/feedback`],
    );

    expect(await screen.findByRole("heading", { name: "Home" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Send feedback" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
  });
});
