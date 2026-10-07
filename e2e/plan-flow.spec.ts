import { expect, test } from "@playwright/test";

/**
 * Core journey, keyless half: home → "Plan Maya's week, live" → the case sheet. With no Qloo key the product must
 * refuse, not pretend: the failure is stated and zero cards are drawn (R10: no mocked default path). The live half,
 * with keys, is e2e/live-plan.spec.ts and scripts/ui_smoke.py.
 */
test.skip(!!process.env.E2E_LIVE, "keyless behaviour; live deployments run e2e/live-plan.spec.ts instead");

test("without provider keys, Plan Maya opens her case and invents no week", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("start-maya").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Week 1 · Maya");
  await expect(page.getByText("FICTIONAL CASE", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Phoebe Bridgers").first()).toBeVisible(); // the seeded loves come from fixtures, not the model
  await expect(page.getByText("The plan could not finish.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("No week is invented when this happens.")).toBeVisible();
  await expect(page.getByTestId("slot-card")).toHaveCount(0);
});

test("intake starts empty and asks for 3–6 confirmed loves", async ({ page }) => {
  await page.goto("/cases/new");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("A new fictional case");
  await expect(page.getByText("What she loved before (0 of 3–6 confirmed)")).toBeVisible();
});

test("health reports the missing keys honestly (503), never a fake ok", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(503);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.qloo.ok).toBe(false);
});
