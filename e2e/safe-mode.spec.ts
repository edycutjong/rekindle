import { expect, test } from "@playwright/test";

/**
 * a2a r06 safe mode, keyless, against a second local server started with STORE_FAULT=unavailable (playwright.config.ts;
 * the hook is ignored on production). Every store call fails there, so the server runs on per-instance memory:
 * saved weeks are "unavailable right now" (never "Not found", never a 500), and a new week still runs, under a banner.
 */
test.skip(!!process.env.E2E_BASE_URL, "needs the local STORE_FAULT server");
test.use({ baseURL: "http://localhost:3101" });

test("QA round 4 (a2a r06): with the store down, a saved week is 'unavailable right now' and the API answers 503 with retry-after", async ({ page, request }) => {
  const id = crypto.randomUUID();
  const res = await page.goto(`/plans/${id}`);
  expect(res?.status()).toBeLessThan(500);
  await expect(page.getByTestId("store-unavailable")).toBeVisible();
  await expect(page.getByText("isn't on file")).toHaveCount(0);
  await expect(page).toHaveTitle("Unavailable right now · Rekindle");
  const api = await request.get(`/api/plans/${id}`);
  expect(api.status()).toBe(503);
  expect(api.headers()["retry-after"]).toBe("60");
  expect((await api.json()).store).toBe("unavailable");
});

test("QA round 4 (a2a r06): with the store down, a new case still streams a week (the labelled outage demo, no keys) under the safe-mode banner", async ({ page }) => {
  const seeded = await page.request.post("/api/cases/seed/maya");
  expect(seeded.status()).toBe(201);
  expect(seeded.headers()["x-store-degraded"]).toBe("1");
  const { case: c } = await seeded.json();
  await page.goto(`/cases/${c.id}?fault=qloo_unreachable`);
  await expect(page.getByTestId("degraded-banner")).toBeVisible();
  await expect(page).toHaveURL(/\/plans\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await expect(page.getByTestId("outage-banner")).toBeVisible();
  // the week lives in this server's memory: a reload still shows it, with the banner
  await page.reload();
  await expect(page.getByTestId("degraded-banner")).toBeVisible();
  await expect(page.getByTestId("outage-banner")).toBeVisible();
});
