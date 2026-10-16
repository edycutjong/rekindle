import { expect, test } from "@playwright/test";

// /judge must answer with no credentials, no cookies and no redirect: it is the one page built for the judge.
test("/judge is 200 with no credentials and no session, and shows the receipts", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  const res = await page.goto(`${baseURL}/judge`);
  expect(res?.status()).toBe(200);
  expect(res?.request().redirectedFrom()).toBeNull();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Receipts: what the agent did, and how often a plan was wrong");
  await expect(page.getByText("No login. Every case is fictional.")).toBeVisible();
  // the claim, path, reproduce, limitations and links JUDGE.md promises are on the page itself
  await expect(page.getByTestId("claim")).toContainText("Rekindle is a behavioral-activation planning agent for clinicians.");
  await expect(page.getByTestId("click-path").getByRole("listitem")).toHaveCount(3);
  await expect(page.getByTestId("receipt-line")).toContainText(/\d+ Vitest tests in \d+ files/);
  await expect(page.getByTestId("reproduce")).toContainText("scripts/ui_smoke.py https://rekindle.edycu.dev");
  await expect(page.getByTestId("limitations").getByRole("listitem")).toHaveCount(4);
  // the repository is public (2026-10-17): /judge links into it unless REPO_PUBLIC=0, which names every repo file as text
  // marked "(public at submission)" so no link 404s for a private repository (QA round 6, a2a r09)
  const links = page.getByTestId("links");
  const pub = await links.getAttribute("data-repo-public");
  if (!process.env.E2E_BASE_URL) expect(pub).toBe(process.env.REPO_PUBLIC === "0" ? "0" : "1");
  if (pub === "1") {
    await expect(links.getByRole("link", { name: "GitHub repository" })).toHaveAttribute("href", "https://github.com/edycutjong/rekindle");
  } else {
    await expect(links.getByTestId("repo-file").first()).toHaveText("GitHub repository (public at submission)");
    await expect(page.locator('a[href^="https://github.com/edycutjong/rekindle"]')).toHaveCount(0);
    await expect(page.getByTestId("reproduce")).toContainText("the repository is private until submission");
  }
  await expect(page.getByTestId("edge-states")).toBeVisible();
  await expect(page.getByTestId("bench-table")).toBeVisible(); // read from the committed bench/results.json
  await ctx.close();
});
