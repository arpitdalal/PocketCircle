import { convexTest } from "convex-test";
import schema from "../convex/schema.js";
import { signInAs } from "./mockAuth.js";
import { seedPersonalFixture } from "./seed.js";

/** Shared Ada + Personal Circle profile for My Transactions convex-tests. */
export const ADA_PERSONAL = {
  email: "ada@example.com",
  displayName: "Ada",
  onboarded: true,
} as const;

/**
 * One harness for My Transactions tests: convexTest + signed-in Ada Personal Circle.
 * `modules` stays caller-local (`import.meta.glob` must be file-scoped).
 */
export function beginMyTransactionsTest(modules: Record<string, () => Promise<unknown>>) {
  const t = convexTest(schema, modules);
  return {
    t,
    async signedInPersonal() {
      const personal = await t.run((ctx) => seedPersonalFixture(ctx, ADA_PERSONAL));
      signInAs(personal.owner);
      return personal;
    },
  };
}
