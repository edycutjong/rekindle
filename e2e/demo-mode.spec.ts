import { expect, test } from "@playwright/test";

// Smoke: the deploy renders without credentials, with real metadata and no console errors.
test.describe("smoke (no keys, no session)", () => {
  test("home renders the pitch and the live start button, with no console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("/");
    await expect(page).toHaveTitle(/Rekindle/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("A week of things she used to love");
    await expect(page.getByTestId("start-maya")).toBeVisible();
    await expect(page.getByTestId("new-case")).toBeVisible();
    await expect(page.locator("nextjs-portal")).toHaveCount(0); // no Next.js error overlay
    expect(errors).toEqual([]);
  });

  test("Open Graph and Twitter card metadata point at the real image", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", /Rekindle/);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /og-image\.png/);
    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
    const og = await page.request.get("/og-image.png");
    expect(og.status()).toBe(200);
  });

  test("an unknown plan is a 404 page titled 'Not found · Rekindle', not a crash", async ({ page }) => {
    const res = await page.goto("/plans/does-not-exist");
    expect(res?.status()).toBe(404);
    await expect(page).toHaveTitle(/Not found · Rekindle/);
  });
});
