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
  // every picture a reader can see loads (they are lazy; a picture hidden at this width is never rendered or fetched)
  // (B21) a fast scroll loop can skip the frame in which a lazy image would have started loading, so each rendered
  // image is brought on screen and waited for before the check
  for (const img of await page.locator("img").all()) {
    if (!(await img.isVisible())) continue;
    await img.scrollIntoViewIfNeeded();
    await expect.poll(() => img.evaluate((i) => (i as HTMLImageElement).complete)).toBe(true);
  }
  const broken = await page.$$eval("img", (imgs) =>
    imgs.filter((i) => i.getClientRects().length > 0 && !(i as HTMLImageElement).naturalWidth).map((i) => i.getAttribute("src")),
  );
  expect(broken).toEqual([]);
  expect(errors).toEqual([]);
});

test("/about's replay waits to be asked, and on a laptop keeps its height from step to step", async ({ page, isMobile }) => {
  await page.goto("/about");
  const box = page.locator(".rp-box");
  await box.scrollIntoViewIfNeeded();
  // no autoplay: well past one old 4.8 s step, it still shows step 5, the re-plan
  await page.waitForTimeout(5500);
  await expect(page.locator('.rp-state[data-s="4"]')).toBeVisible();
  await expect(page.locator('.rp-state[data-s="0"]')).toBeHidden();
  if (!isMobile) {
    // every step stays in one grid cell, so nothing below the replay moves when the step changes
    const height = () => box.evaluate((e) => Math.round(e.getBoundingClientRect().height));
    const h0 = await height();
    for (const k of [0, 1, 2, 3, 4]) {
      await page.locator(`.rp-tab[data-go="${k}"]`).click();
      await expect(page.locator(`.rp-state[data-s="${k}"]`)).toBeVisible();
      expect(await height()).toBe(h0);
    }
  }
});

test("/about says what was measured and who measured it, and stays under 10,000 px on a laptop", async ({ page, isMobile }) => {
  await page.goto("/about");
  const text = (await page.locator("main").innerText()).replace(/\s+/g, " ");
  // QA B21: the ablation counted tags and keywords, never menus; the manual audit was done by an AI, so it says so
  expect(text).not.toMatch(/serve alcohol,|outings that serve alcohol|outings serving alcohol|checked by hand|Hand-checked/);
  expect(text).toContain("carry an alcohol tag or keyword");
  expect(text).toContain("our build agent (Claude, an AI; not blind)");
  await expect(page.locator(".rtag").first()).toHaveText(/Manual audit · Claude/);
  if (!isMobile) {
    // the exemplars run 5,500 to 7,100 px at this width; the page was 13,706 before B21
    await page.setViewportSize({ width: 1440, height: 900 });
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(h).toBeLessThanOrEqual(10_000);
    // each replay step shows its changed slots at the hero sheet's sizes: no replay text under 13 px, names 16 px or more
    for (const k of [0, 1, 2, 3, 4]) {
      await page.locator(`.rp-tab[data-go="${k}"]`).click();
      const small = await page.locator(`.rp-state[data-s="${k}"]`).evaluate((st) => {
        const out: string[] = [];
        st.querySelectorAll("*").forEach((el) => {
          const own = [...el.childNodes].some((n) => n.nodeType === 3 && /\w/.test(n.textContent ?? ""));
          if (own && parseFloat(getComputedStyle(el).fontSize) < 13) out.push((el.textContent ?? "").slice(0, 40));
        });
        st.querySelectorAll(".nm, .rp-struck s, .rp-review .rn, .rp-home .n, .rp-strip .n").forEach((el) => {
          if (parseFloat(getComputedStyle(el).fontSize) < 16) out.push("name " + (el.textContent ?? "").slice(0, 40));
        });
        return out;
      });
      expect(small).toEqual([]);
    }
  } else {
    // on a phone every step tab is on screen, the open one included
    const tab = await page.locator('.rp-tab[aria-current="step"]').boundingBox();
    const vw = page.viewportSize()!.width;
    expect(tab && tab.x >= 0 && tab.x + tab.width <= vw).toBe(true);
  }
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
  // print to PDF: one 16 in × 9 in page per slide (a length pair takes no orientation keyword, or the size is dropped)
  const pageSize = await page.evaluate(() =>
    [...document.styleSheets].flatMap((s) => [...s.cssRules]).filter((r) => r instanceof CSSPageRule).map((r) => (r as CSSPageRule).style.getPropertyValue("size")),
  );
  expect(pageSize).toEqual(["16in 9in"]);
  // QA B21: the cover quotes the app's summary whole, caveat included, and its cursor never prints
  await page.goto("/pitch#1");
  await expect(page.locator(".s1 .tcard .sum")).toContainText("2 rekindled by a rating (Qloo's attribution, not causation)");
  await page.emulateMedia({ media: "print" });
  expect(await page.locator(".s1 .cur").evaluate((c) => getComputedStyle(c).display)).toBe("none");
  await page.emulateMedia({ media: "screen" });
  expect(errors).toEqual([]);
});
