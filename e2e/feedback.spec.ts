import { createRegularCircleAndFinishSetup, expect, test } from "./fixtures.js";

/**
 * TRUE-E2E (ADR 0019 / #270): Circle chrome Feedback carries the resolved Circle
 * context, submits successfully, and Back restores the originating Circle URL.
 */
test("circle chrome feedback submits with resolved context and returns to the origin", async ({
  page,
}) => {
  const name = `E2E Feedback ${Date.now()}`;
  await createRegularCircleAndFinishSetup(page, { name });
  const originUrl = page.url();

  await page.getByRole("link", { name: `Send feedback about ${name}` }).click();
  await expect(page.getByRole("heading", { name: "Send feedback" })).toBeVisible();
  await expect(page.getByText(`Circle context: ${name}`)).toBeVisible();

  await page.getByLabel("Message").fill("The dashboard totals look off.");
  await page.getByRole("button", { name: "Send feedback" }).click();
  await expect(page.getByText("Thanks — your feedback was sent.")).toBeVisible();

  await page.getByRole("link", { name: /Back/ }).click();
  await expect(page).toHaveURL(originUrl);
  await expect(page.getByRole("heading", { name })).toBeVisible();
});
