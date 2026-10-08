import { expect, test } from "@playwright/test";

// The story page (/about) and the pitch deck (/pitch) are static files in public/: they must load with no credentials,
// no console errors and no broken image, and send a judge to the live app. Their bench and test numbers are written
// by scripts/site.py from bench/*.json and docs/rigor.json (npm run docs:check fails when they drift).

test("/about tells the story and sends a judge to the live app", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  const res = await page.goto("/about");
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/The schedule that\s*crosses things out\s*and then lights up\s*what she liked\./);
  const cta = page.getByRole("link", { name: /Plan Maya's week, live/ }).first();
  await expect(cta).toHaveAttribute("href", "https://rekindle.edycu.dev/");
  await expect(page.getByText("Maya is a fictional case.").first()).toBeAttached();
  // the five-step replay of the recorded week: every step can be shown, the last is the re-plan
  const tabs = page.locator(".rp-tab");
  await expect(tabs).toHaveCount(5);
  await tabs.nth(1).click();
  await expect(page.locator('.rp-state[data-s="1"]')).toBeVisible();
  await expect(page.locator('.rp-state[data-s="1"] .rp-notice')).toContainText("struck in place");
  // the FAQ opens
  await page.getByText("Is anything replayed or mocked?").click();
  await expect(page.getByText("Captured Qloo responses are used only in unit tests.")).toBeVisible();
  // every picture loads (scroll first: they are lazy)
  for (let y = 0; y < 16000; y += 900) await page.evaluate((v) => window.scrollTo(0, v), y);
  await page.waitForLoadState("networkidle");
  const broken = await page.$$eval("img", (imgs) => imgs.filter((i) => !(i as HTMLImageElement).naturalWidth).map((i) => i.getAttribute("src")));
  expect(broken).toEqual([]);
  expect(errors).toEqual([]);
});

test("/pitch is an 11-slide deck that keyboard and URL navigate", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const res = await page.goto("/pitch");
  expect(res?.status()).toBe(200);
  await expect(page.locator(".slide")).toHaveCount(11);
  await expect(page.locator(".slide.on .foot .n")).toHaveText("01 / 11");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".slide.on .foot .n")).toHaveText("02 / 11");
  await page.goto("/pitch#11");
  await expect(page.locator(".slide.on .foot .n")).toHaveText("11 / 11");
  await expect(page.locator(".slide.on .qr svg")).toBeVisible();
  const broken = await page.$$eval("img", (imgs) => imgs.filter((i) => (i as HTMLImageElement).complete && !(i as HTMLImageElement).naturalWidth).map((i) => i.getAttribute("src")));
  expect(broken).toEqual([]);
  // the 1920×1080 stage fits the window (scaled, never cropped)
  const fit = await page.evaluate(() => {
    const r = document.querySelector(".slide.on")!.getBoundingClientRect();
    return r.left >= -1 && r.top >= -1 && r.right <= document.documentElement.clientWidth + 1 && r.bottom <= document.documentElement.clientHeight + 1;
  });
  expect(fit).toBe(true);
  expect(errors).toEqual([]);
});
