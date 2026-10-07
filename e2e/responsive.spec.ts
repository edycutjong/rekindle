import { expect, test } from "@playwright/test";

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];
const PAGES = ["/", "/judge", "/cases/new", "/integrations/qloo"];

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name} ${vp.width}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });
    for (const path of PAGES) {
      test(`${path} has no horizontal scroll`, async ({ page }) => {
        await page.goto(path);
        const sw = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(sw).toBeLessThanOrEqual(vp.width);
      });
    }
    test("home: the primary actions are at least 36 px tall and the header fits", async ({ page }) => {
      await page.goto("/");
      for (const id of ["start-maya", "new-case"]) {
        const box = await page.getByTestId(id).boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(36);
      }
      const header = await page.locator("header").first().boundingBox();
      expect(header?.width ?? 0).toBeLessThanOrEqual(vp.width);
    });
  });
}
