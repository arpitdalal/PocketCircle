import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  social: vi.fn(),
  signOut: vi.fn(),
  deleteUser: vi.fn(),
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
    signOut: auth.signOut,
    deleteUser: auth.deleteUser,
  })),
}));

import {
  confirmAccountDeletion,
  requestAccountDeletion,
  signInWithGoogle,
  signOut,
} from "./auth-client.js";
import {
  clearLastUsedGoogleEmail,
  getLastUsedGoogleEmail,
  setLastUsedGoogleEmail,
} from "./last-used-google-email.js";

afterEach(() => {
  vi.clearAllMocks();
  clearLastUsedGoogleEmail();
});

describe("signInWithGoogle", () => {
  it("starts Google sign-in with the callback URL", async () => {
    auth.social.mockResolvedValue({ data: { redirect: true }, error: null });

    await signInWithGoogle("/after-auth");

    expect(auth.social).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "/after-auth",
    });
  });

  it("forwards loginHint when provided", async () => {
    auth.social.mockResolvedValue({ data: { redirect: true }, error: null });

    await signInWithGoogle("/after-auth", { loginHint: "a@b.com" });

    expect(auth.social).toHaveBeenCalledWith({
      provider: "google",
      callbackURL: "/after-auth",
      loginHint: "a@b.com",
    });
  });

  it("throws if Better Auth resolves with an error object", async () => {
    const error = { message: "Invalid origin" };
    auth.social.mockResolvedValue({ data: null, error });

    await expect(signInWithGoogle("/")).rejects.toBe(error);
  });
});

describe("signOut", () => {
  it("resolves when Better Auth signs the user out", async () => {
    auth.signOut.mockResolvedValue({ data: { success: true }, error: null });

    await expect(signOut()).resolves.toBeUndefined();
    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });

  it("does not clear the last-used Google email hint", async () => {
    setLastUsedGoogleEmail("ada@gmail.com");
    auth.signOut.mockResolvedValue({ data: { success: true }, error: null });

    await signOut();

    expect(getLastUsedGoogleEmail()).toBe("ada@gmail.com");
  });

  // Better Auth surfaces failures as a resolved `{ error }` object, not a rejection;
  // the wrapper must throw so callers can drive their failure UX off it (#132).
  it("throws if Better Auth resolves with an error object", async () => {
    const error = { message: "Sign-out failed" };
    auth.signOut.mockResolvedValue({ data: null, error });

    await expect(signOut()).rejects.toBe(error);
  });
});

describe("requestAccountDeletion", () => {
  it("starts verified deletion through Better Auth deleteUser", async () => {
    auth.deleteUser.mockResolvedValue({ data: {}, error: null });

    await expect(requestAccountDeletion()).resolves.toBeUndefined();
    expect(auth.deleteUser).toHaveBeenCalledWith();
  });

  it("throws if Better Auth resolves with an error object", async () => {
    const error = { message: "Blocked" };
    auth.deleteUser.mockResolvedValue({ data: null, error });

    await expect(requestAccountDeletion()).rejects.toBe(error);
  });
});

describe("confirmAccountDeletion", () => {
  it("submits the verification token to Better Auth deleteUser", async () => {
    auth.deleteUser.mockResolvedValue({ data: {}, error: null });

    await expect(confirmAccountDeletion("tok-1")).resolves.toBeUndefined();
    expect(auth.deleteUser).toHaveBeenCalledWith({ token: "tok-1" });
  });

  it("throws if Better Auth resolves with an error object", async () => {
    const error = { message: "Invalid token" };
    auth.deleteUser.mockResolvedValue({ data: null, error });

    await expect(confirmAccountDeletion("bad")).rejects.toBe(error);
  });
});
