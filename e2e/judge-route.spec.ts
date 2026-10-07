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
  await expect(page.getByTestId("edge-states")).toBeVisible();
  await expect(page.getByTestId("bench-table")).toBeVisible(); // read from the committed bench/results.json
  await ctx.close();
});
