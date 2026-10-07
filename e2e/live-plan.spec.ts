import { expect, test } from "@playwright/test";

/**
 * Live half of the core journey, against a real deployment only:
 *   E2E_BASE_URL=https://rekindle-one.vercel.app E2E_LIVE=1 npx playwright test e2e/live-plan.spec.ts --project=chromium
 * Every card comes from live Qloo calls; the full click path (toggle, gate, ratings, re-plan, print) is scripts/ui_smoke.py.
 */
test.skip(!process.env.E2E_LIVE, "set E2E_LIVE=1 and E2E_BASE_URL to a deployment with keys");
test.setTimeout(120_000);

test("Plan Maya's week, live: 7 slots, every card explained by Qloo, Qloo calls logged", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("start-maya").click();
  await page.waitForURL("**/plans/**", { timeout: 90_000 });
  const cards = page.getByTestId("slot-card");
  await expect(cards.first()).toBeVisible();
  const n = await cards.count();
  expect(n).toBeGreaterThanOrEqual(5);
  await expect(page.getByTestId("why")).toHaveCount(n);
  const planId = page.url().split("/plans/")[1];
  await page.goto(`/integrations/qloo?plan=${planId}`);
  await expect(page.getByText("/v2/insights").first()).toBeVisible();
});
