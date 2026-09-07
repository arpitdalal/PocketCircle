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
    expect(screen.getByText(/one place for the money you share/i)).toBeInTheDocument();
    expect(
      screen.getAllByText(/track spending together in shared Circles/i).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/circles for every shared life/i)).toBeInTheDocument();
    expect(screen.getByText(/AI-native, with you in control/i)).toBeInTheDocument();
    expect(screen.getByText(/Connect AI assistants over MCP/i)).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Continue with Google" }).length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/By continuing you agree to our/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("navigation", { name: "Product" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Account" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Legal" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Circles" })).toHaveAttribute("href", "#circles");
    expect(screen.getByRole("link", { name: "AI & MCP" })).toHaveAttribute("href", "#ai");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/signin");
    expect(screen.getByRole("link", { name: "What's new" })).toHaveAttribute("href", "/whats-new");
    expect(screen.getByRole("link", { name: "Support" })).toHaveAttribute("href", "/support");
    expect(screen.getByRole("link", { name: "Sitemap" })).toHaveAttribute("href", "/sitemap.xml");
    expect(
      screen.getByText(`© ${new Date().getFullYear()} PocketCircle. All rights reserved.`),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Feedback" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Connections" })).not.toBeInTheDocument();
    const privacyLinks = screen.getAllByRole("link", { name: "Privacy Policy" });
    expect(privacyLinks.length).toBeGreaterThanOrEqual(1);
    for (const link of privacyLinks) {
      expect(link).toHaveAttribute("href", "/privacy");
    }
    const termsLinks = screen.getAllByRole("link", { name: "Terms" });
    expect(termsLinks.length).toBeGreaterThanOrEqual(1);
    for (const link of termsLinks) {
      expect(link).toHaveAttribute("href", "/terms");
    }
  });
});

describe("MarketingHomeRoute (/home)", () => {
  it("renders the same marketing page without an auth gate", () => {
    renderRoutes(<Route path="/home" element={<MarketingHomeRoute />} />, {
      initialEntries: ["/home"],
    });

    expect(screen.getByRole("heading", { name: "PocketCircle" })).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Continue with Google" }).length,
    ).toBeGreaterThanOrEqual(1);
  });
});
