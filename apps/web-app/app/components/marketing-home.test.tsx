import { screen } from "@testing-library/react";
import { Route } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MarketingHome } from "~/components/marketing-home.js";
import MarketingHomeRoute from "~/routes/marketing-home.js";
import { configureConvex, convexReactMock, renderRoutes } from "~/test/convex-react.js";

vi.mock("@convex-dev/better-auth/client/plugins", () => ({
  convexClient: vi.fn(),
  crossDomainClient: vi.fn(),
}));

vi.mock("better-auth/react", () => ({
  createAuthClient: vi.fn(() => ({
    signIn: {
      social: vi.fn(),
    },
  })),
}));

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

beforeEach(() => {
  configureConvex();
  convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
});

describe("MarketingHome", () => {
  it("names PocketCircle, explains purpose, and starts Google sign-in in one click", () => {
    renderRoutes(<Route path="/" element={<MarketingHome />} />);

    expect(screen.getByRole("heading", { name: "PocketCircle" })).toBeInTheDocument();
    expect(screen.getByText(/track spending together in shared Circles/i)).toBeInTheDocument();
    expect(screen.queryByText(/assistants/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
    expect(screen.getByText(/By continuing you agree to our/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
  });
});

describe("MarketingHomeRoute (/home)", () => {
  it("renders the same marketing page without an auth gate", () => {
    renderRoutes(<Route path="/home" element={<MarketingHomeRoute />} />, {
      initialEntries: ["/home"],
    });

    expect(screen.getByRole("heading", { name: "PocketCircle" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeInTheDocument();
  });
});
