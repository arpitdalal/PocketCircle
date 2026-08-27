import { vi } from "vitest";
import type { Doc } from "../convex/_generated/dataModel.js";

/**
 * Shared Better Auth boundary double for convex-test (ADR 0006). The auth
 * component is unrunnable under convex-test; callers still seed real User rows
 * and exercise real domain wiring. Import this module and wire:
 *
 *   vi.mock("../convex/auth.js", async () => (await import("./mockAuth.js")).authMockModule());
 *
 * Path to `auth.js` is relative to the test file (usually `./auth.js` from
 * `packages/convex/convex/*.test.ts`).
 */

export const mockCurrentUser = vi.fn();

export function authMockModule() {
  return {
    getCurrentUserOrNull: mockCurrentUser,
    requireCurrentUser: async (ctx: unknown) => {
      const user = await mockCurrentUser(ctx);
      if (!user) {
        throw new Error("Not authenticated");
      }
      return user;
    },
  };
}

export function resetMockCurrentUser() {
  mockCurrentUser.mockReset();
}

export function signInAs(user: Doc<"users"> | null) {
  mockCurrentUser.mockResolvedValue(user);
}
