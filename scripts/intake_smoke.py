#!/usr/bin/env python3
"""Intake E2E (spec Core Feature 1, step 1 of the one flow) on a real deployment, logged out:
home -> "New fictional case" -> type three loves, each resolved live by Qloo (/search or /v2/tags through /api/resolve)
and confirmed by clicking a chip -> neighbourhood, energy, constraints -> save -> week 1 plans live -> 7 slots.
Also: the form has no horizontal scroll at 375 px, and an unknown route shows the styled 404 with links back.
Usage: python3 scripts/intake_smoke.py <base-url> <screenshot-dir> [tag]   -> prints JSON; exits 1 on a failed gate."""
import json, sys, time
from playwright.sync_api import sync_playwright

base, out = sys.argv[1].rstrip("/"), sys.argv[2]
tag = sys.argv[3] if len(sys.argv) > 3 else "local"
LOVES = [("artist", "Phoebe Bridgers"), ("tv_show", "Fleabag"), ("place_tag", "ramen")]
res, gates = {}, {}

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={"width": 1440, "height": 1000}).new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(base + "/", wait_until="networkidle")
    gates["home_links_intake"] = pg.locator("[data-testid=new-case]").count() == 1
    pg.click("[data-testid=new-case]")
    pg.wait_for_selector("[data-testid=intake]")
    gates["submit_disabled_until_ready"] = pg.locator("[data-testid=intake-submit]").is_disabled()
    pg.fill("[data-testid=intake-label]", "Rosa")
    rows = pg.locator("[data-testid=intake-love]")
    picked = []
    for n, (kind, text) in enumerate(LOVES):
        row = rows.nth(n)
        row.locator("select").select_option(kind)
        row.locator("[data-testid=intake-love-text]").fill(text)
        row.locator("[data-testid=love-chip]").first.wait_for(timeout=20000)
        chip = row.locator("[data-testid=love-chip]").first
        picked.append(chip.inner_text())
        chip.click()
    res["picked"] = picked
    pg.select_option("[data-testid=intake-point]", label="Williamsburg, Brooklyn")
    gates["submit_enabled_with_3_confirmed"] = pg.locator("[data-testid=intake-submit]").is_enabled()
    pg.screenshot(path=f"{out}/{tag}-intake-1440.png", full_page=True)
    t = time.time()
    pg.click("[data-testid=intake-submit]")
    pg.wait_for_url("**/plans/**", timeout=120000)
    pg.wait_for_selector("[data-testid=ledger]")
    time.sleep(1)
    res["plan_seconds_from_save"] = round(time.time() - t, 1)
    res["slots"] = pg.locator("[data-testid=slot-card]").count() + pg.locator("[data-testid=empty-slot]").count() + pg.locator("[data-testid=qloo-unavailable]").count()
    res["cards"] = pg.locator("[data-testid=slot-card]").count()
    res["case_strip"] = pg.locator("h1").first.inner_text()
    gates["intake_case_plans_live"] = res["slots"] == 7 and res["cards"] >= 4
    pg.screenshot(path=f"{out}/{tag}-intake-week1-1440.png", full_page=True)
    # styled 404 with a way back
    pg.goto(base + "/plans/00000000-0000-0000-0000-000000000000", wait_until="networkidle")
    res["nf_title"] = pg.locator("h1").first.inner_text()
    gates["not_found_has_header_and_links"] = pg.locator("header").count() == 1 and pg.locator("[data-testid=nf-home]").count() == 1 and pg.locator("[data-testid=nf-judge]").count() == 1
    pg.screenshot(path=f"{out}/{tag}-404-1440.png", full_page=False)
    mp = b.new_context(viewport={"width": 375, "height": 812}, device_scale_factor=2, is_mobile=True, has_touch=True).new_page()
    mp.goto(base + "/cases/new", wait_until="networkidle")
    res["intake_375_scroll_width"] = mp.evaluate("document.documentElement.scrollWidth")
    gates["intake_375_no_scroll"] = res["intake_375_scroll_width"] <= 375
    mp.screenshot(path=f"{out}/{tag}-intake-375.png", full_page=True)
    res["page_errors"] = errs
    gates["no_page_errors"] = not errs
    b.close()

res["gates"] = gates
print(json.dumps(res, indent=1))
for k, v in gates.items():
    print(("PASS " if v else "FAIL ") + k)
sys.exit(0 if all(gates.values()) else 1)
