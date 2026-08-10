import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureConvex,
  convexReactMock,
  makeCurrentUserView,
  renderRoutes,
} from "~/test/convex-react.js";

const auth = vi.hoisted(() => ({
  confirmAccountDeletion: vi.fn(),
  signInWithGoogle: vi.fn(),
}));

vi.mock("@convex-dev/better-auth/client/plugins", () => ({
  convexClient: vi.fn(),
  crossDomainClient: vi.fn(),
}));

vi.mock("better-auth/react", () => ({
  createAuthClient: vi.fn(() => ({
    deleteUser: vi.fn(),
    signIn: { social: vi.fn() },
  })),
}));

vi.mock("~/lib/auth-client.js", () => ({
  confirmAccountDeletion: auth.confirmAccountDeletion,
  signInWithGoogle: auth.signInWithGoogle,
}));

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

import DeleteAccountComplete from "./delete-account-complete.js";
import DeleteAccountVerify from "./delete-account-verify.js";

beforeEach(() => {
  configureConvex();
  convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: false, isLoading: false });
  auth.confirmAccountDeletion.mockReset();
  auth.signInWithGoogle.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderVerify(token: string | null = "del-token") {
  const path = token === null ? "/delete-account/verify" : `/delete-account/verify?token=${token}`;
  return renderRoutes(
    <>
      <Route path="/delete-account/verify" element={<DeleteAccountVerify />} />
      <Route path="/delete-account/complete" element={<DeleteAccountComplete />} />
      <Route path="/settings" element={<div>settings-page</div>} />
    </>,
    { initialEntries: [path] },
  );
}

describe("Delete account verify", () => {
  it("explains sign-in and returns to the exact verification URL after Google", async () => {
    auth.signInWithGoogle.mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderVerify("return-token");

    expect(
      screen.getByText(/Sign in with the same Google account to confirm account deletion/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in with Google" }));
    expect(auth.signInWithGoogle).toHaveBeenCalledWith("/delete-account/verify?token=return-token");
    expect(auth.confirmAccountDeletion).not.toHaveBeenCalled();
  });

  it("submits the token once when signed in and routes to completion", async () => {
    auth.confirmAccountDeletion.mockResolvedValue(undefined);
    configureConvex({ currentUser: makeCurrentUserView() });
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });

    const view = renderVerify("once-token");

    await waitFor(() => {
      expect(auth.confirmAccountDeletion).toHaveBeenCalledWith("once-token");
    });
    expect(auth.confirmAccountDeletion).toHaveBeenCalledOnce();
    expect(await screen.findByText(/Account deleted/i)).toBeInTheDocument();
    expect(view.location()).toBe("/delete-account/complete");
  });

  it("shows a generic error for missing tokens without calling delete", () => {
    renderVerify(null);
    expect(screen.getByRole("alert")).toHaveTextContent(/invalid or expired/i);
    expect(auth.confirmAccountDeletion).not.toHaveBeenCalled();
  });

  it("shows a generic error when confirmation fails and offers Settings retry", async () => {
    auth.confirmAccountDeletion.mockRejectedValue(new Error("bad token"));
    configureConvex({ currentUser: makeCurrentUserView() });
    convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });

    renderVerify("bad-token");

    expect(await screen.findByRole("alert")).toHaveTextContent(/invalid or expired/i);
    expect(screen.getByRole("link", { name: "Back to Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
  });
});

describe("Delete account complete", () => {
  it("confirms deletion and links to sign-in", () => {
    renderRoutes(<Route path="/delete-account/complete" element={<DeleteAccountComplete />} />, {
      initialEntries: ["/delete-account/complete"],
    });
    expect(screen.getByRole("heading", { name: "Account deleted" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute(
      "href",
      "/signin",
    );
  });
});
