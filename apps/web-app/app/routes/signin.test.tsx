import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureConvex,
  convexReactMock,
  makeCurrentUserView,
  renderRoutes,
  renderWithRouter,
} from "~/test/convex-react.js";
import {
  clearLastUsedGoogleEmailStorage,
  seedLastUsedGoogleEmail,
  simulateCrossTabLastUsedGoogleEmailClear,
} from "~/test/last-used-google-email.js";

const auth = vi.hoisted(() => ({
  social: vi.fn(),
}));

vi.mock("@convex-dev/better-auth/client/plugins", () => ({
  convexClient: vi.fn(),
  crossDomainClient: vi.fn(),
}));

vi.mock("better-auth/react", () => ({
  createAuthClient: vi.fn(() => ({
    signIn: {
      social: auth.social,
    },
  })),
}));

// The route guard reads the real session (`useAppSession`), so double `convex/react`
// — the auth boundary — and default to a resolved, unauthenticated session so the
// form renders; the "already signed in" case overrides this per-test.
vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

import SignIn from "./signin.js";

beforeEach(() => {
  configureConvex();
  convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
  clearLastUsedGoogleEmailStorage();
});

afterEach(() => {
  vi.clearAllMocks();
  clearLastUsedGoogleEmailStorage();
});

describe("SignIn", () => {
  it("shows loading feedback while Google sign-in starts", async () => {
    const user = userEvent.setup();
    let resolveSignIn = () => {};
    auth.social.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSignIn = resolve;
      }),
    );

    renderWithRouter(<SignIn />);

    const button = screen.getByRole("button", { name: "Continue with Google" });
    await user.click(button);

    expect(auth.social).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "/",
    });
    expect(screen.getByRole("button", { name: "Signing in..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Signing in..." })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(
      screen.getByRole("button", { name: "Signing in..." }).querySelector(".animate-spin"),
    ).toBeInTheDocument();

    resolveSignIn();
  });

  it("prevents duplicate Google sign-in requests while pending", async () => {
    const user = userEvent.setup();
    auth.social.mockReturnValue(new Promise<void>(() => {}));

    renderWithRouter(<SignIn />);

    await user.dblClick(screen.getByRole("button", { name: "Continue with Google" }));

    expect(auth.social).toHaveBeenCalledOnce();
  });

  it("re-enables sign-in and shows an error if OAuth startup throws", async () => {
    const user = userEvent.setup();
    auth.social.mockRejectedValue(new Error("network"));

    renderWithRouter(<SignIn />);

    await user.click(screen.getByRole("button", { name: "Continue with Google" }));

    expect(await screen.findByText("Couldn't start Google sign-in. Try again.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
  });

  it("re-enables sign-in and shows an error if OAuth startup returns an auth error", async () => {
    const user = userEvent.setup();
    auth.social.mockResolvedValue({ data: null, error: { message: "Invalid origin" } });

    renderWithRouter(<SignIn />);

    await user.click(screen.getByRole("button", { name: "Continue with Google" }));

    expect(await screen.findByText("Couldn't start Google sign-in. Try again.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeEnabled();
  });

  it("redirects an already-signed-in visitor to the app instead of showing the form", () => {
    configureConvex({ currentUser: makeCurrentUserView() });
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });

    const view = renderRoutes(
      <>
        <Route path="/signin" element={<SignIn />} />
        <Route path="/" element={<div>app-home</div>} />
      </>,
      { initialEntries: ["/signin"] },
    );

    expect(view.location()).toBe("/");
    expect(screen.getByText("app-home")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue with Google" })).not.toBeInTheDocument();
  });

  it("redirects an already-signed-in visitor to the returnTo origin", () => {
    configureConvex({ currentUser: makeCurrentUserView() });
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });

    const view = renderRoutes(
      <>
        <Route path="/signin" element={<SignIn />} />
        <Route path="/mcp/authorize" element={<div>mcp-consent</div>} />
      </>,
      { initialEntries: ["/signin?returnTo=%2Fmcp%2Fauthorize%3Fhandoff%3Dtest"] },
    );

    expect(view.location()).toBe("/mcp/authorize?handoff=test");
    expect(screen.getByText("mcp-consent")).toBeInTheDocument();
  });

  it("passes returnTo to signInWithGoogle when starting Google sign-in", async () => {
    auth.social.mockResolvedValue({ data: { redirect: true }, error: null });
    const user = userEvent.setup();

    renderRoutes(<Route path="/signin" element={<SignIn />} />, {
      initialEntries: ["/signin?returnTo=%2Fmcp%2Fauthorize%3Fhandoff%3Dtest"],
    });

    await user.click(screen.getByRole("button", { name: "Continue with Google" }));

    expect(auth.social).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "/mcp/authorize?handoff=test",
    });
  });

  it("shows a splash, not the form, while auth is still resolving", () => {
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: true });

    renderWithRouter(<SignIn />);

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue with Google" })).not.toBeInTheDocument();
  });

  it("shows no hint or alternate control when storage is empty", () => {
    renderWithRouter(<SignIn />);

    expect(screen.queryByText(/You used/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Use a different account" }),
    ).not.toBeInTheDocument();
  });

  it("shows a masked hint and alternate control when storage has a valid email", () => {
    seedLastUsedGoogleEmail("alice@gmail.com");

    renderWithRouter(<SignIn />);

    expect(screen.getByText("al***e@gmail.com")).toBeInTheDocument();
    expect(screen.getByText(/You used/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use a different account" })).toBeInTheDocument();
  });

  it("passes loginHint from storage on primary sign-in", async () => {
    seedLastUsedGoogleEmail("alice@gmail.com");
    auth.social.mockResolvedValue({ data: { redirect: true }, error: null });
    const user = userEvent.setup();

    renderWithRouter(<SignIn />);
    await user.click(screen.getByRole("button", { name: "Continue with Google" }));

    expect(auth.social).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "/",
      loginHint: "alice@gmail.com",
    });
  });

  it("omits loginHint when using a different account", async () => {
    seedLastUsedGoogleEmail("alice@gmail.com");
    auth.social.mockResolvedValue({ data: { redirect: true }, error: null });
    const user = userEvent.setup();

    renderWithRouter(<SignIn />);
    await user.click(screen.getByRole("button", { name: "Use a different account" }));

    expect(auth.social).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "/",
    });
  });

  it("drops the hint when another tab clears last-used storage", async () => {
    seedLastUsedGoogleEmail("alice@gmail.com");

    renderWithRouter(<SignIn />);
    expect(screen.getByText("al***e@gmail.com")).toBeInTheDocument();

    simulateCrossTabLastUsedGoogleEmailClear("alice@gmail.com");

    await waitFor(() => {
      expect(screen.queryByText(/You used/i)).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "Use a different account" }),
    ).not.toBeInTheDocument();
  });
});
