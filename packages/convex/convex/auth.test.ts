import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api.js";
import { createAuth } from "./auth.js";
import schema from "./schema.js";

const modules = import.meta.glob("./**/*.ts");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getCurrentUserOrNull (via users.getCurrentUser)", () => {
  // Step 3.2 (unexpected `safeGetAuthUser` throw → log + null): skipped — convex-test
  // cannot force a component failure without mocking `auth.ts` (ADR 0006).
  it("returns null without error logging when there is no session", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    const user = await t.query(api.users.getCurrentUser, {});
    expect(user).toBeNull();
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("createAuth", () => {
  it("starts without Google credentials so first local backend bootstrap can set them later", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret");
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");

    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      const auth = createAuth(ctx);
      await expect(auth.$context).resolves.toBeDefined();
    });
  });

  it("enables verified Account Deletion (USR-3)", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret");
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");

    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const auth = createAuth(ctx);
      const options = await auth.$context;
      expect(options.options.user?.deleteUser?.enabled).toBe(true);
      expect(options.options.user?.deleteUser?.sendDeleteAccountVerification).toEqual(
        expect.any(Function),
      );
    });
  });
});
