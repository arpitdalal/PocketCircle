import { screen } from "@testing-library/react";
import { Route } from "react-router";
import { describe, expect, it } from "vitest";
import { MarketingHome } from "~/components/marketing-home.js";
import MarketingHomeRoute from "~/routes/marketing-home.js";
import { renderRoutes } from "~/test/convex-react.js";

describe("MarketingHome", () => {
  it("names PocketCircle, explains purpose, and links privacy, terms, and sign-in", () => {
    renderRoutes(<Route path="/" element={<MarketingHome />} />);

    expect(screen.getByRole("heading", { name: "PocketCircle" })).toBeInTheDocument();
    expect(screen.getByText(/track spending together in shared Circles/i)).toBeInTheDocument();
    expect(screen.queryByText(/assistants/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/signin");
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
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/signin");
  });
});
