import { expect, homeCircleCard, test } from "./fixtures.js";

/**
 * TRUE-E2E smoke (ADR 0019): per-worker `storageState` from `fixtures.ts` loads the
 * app already authenticated against the REAL self-hosted backend. This exercises the
 * real session → real `listMyCircles` query → render path (no fixtures), proving
 * the frontend↔backend contract end to end.
 */
test("authenticated shell renders the real Personal Circle from the backend", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your circles" })).toBeVisible();
  await expect(homeCircleCard(page, /Your Circle/)).toBeVisible();
});

test("unknown deep links fall back to the safe route (real backend)", async ({ page }) => {
  await page.goto("/this/path/does/not/exist");
  await expect(page.getByRole("heading", { name: "Your circles" })).toBeVisible();
});

test("an already-signed-in visitor to /signin is redirected into the app", async ({ page }) => {
  await page.goto("/signin");
  // The guard bounces an authenticated session to the app root rather than showing the
  // form; ProtectedLayout then renders the shell for this bootstrapped User.
  await expect(page).toHaveURL((url) => url.pathname === "/");
  await expect(page.getByRole("heading", { name: "Your circles" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Continue with Google/ })).toBeHidden();
});
