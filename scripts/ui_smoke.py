#!/usr/bin/env python3
"""Logged-out UI smoke run (build-plan D5/D6 gate): home -> Plan Maya (live) -> week renders -> "In recovery" toggle ->
reload shows the same week -> 375 px has no horizontal scroll -> /integrations/qloo lists the calls.
Usage: python3 scripts/ui_smoke.py <base-url> <screenshot-dir> [tag]   (needs `pip install playwright`).
It drives the real deployment; nothing is mocked."""
import sys, time, json
from playwright.sync_api import sync_playwright
base = sys.argv[1]; out = sys.argv[2]; tag = sys.argv[3] if len(sys.argv) > 3 else "local"
res = {}
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1440, "height": 1000})  # fresh context = logged-out, no cookies
    pg = ctx.new_page()
    errs = []
    pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
    pg.on("pageerror", lambda e: errs.append(str(e)))
    t0 = time.time()
    pg.goto(base + "/", wait_until="networkidle")
    pg.screenshot(path=f"{out}/{tag}-home-1440.png", full_page=True)
    pg.click("[data-testid=start-maya]")
    pg.wait_for_url("**/cases/**", timeout=20000)
    time.sleep(6)
    pg.screenshot(path=f"{out}/{tag}-streaming-1440.png", full_page=True)
    pg.wait_for_url("**/plans/**", timeout=90000)
    res["plan_seconds_from_click"] = round(time.time() - t0, 1)
    pg.wait_for_selector("[data-testid=slot-card]")
    time.sleep(1)
    res["plan_url"] = pg.url
    res["cards"] = pg.locator("[data-testid=slot-card]").count()
    res["struck"] = pg.locator("[data-testid=struck]").count()
    res["why"] = pg.locator("[data-testid=why]").count()
    res["hours"] = pg.locator("[data-testid=hours]").count()
    pg.screenshot(path=f"{out}/{tag}-week1-1440.png", full_page=True)
    # toggle in recovery
    pg.click("[data-testid=tab-in_recovery]")
    pg.wait_for_selector("[data-testid=toggle-notice]", timeout=60000)
    res["toggle_notice"] = pg.locator("[data-testid=toggle-notice]").inner_text()
    res["toggle_url"] = pg.url
    res["struck_after_toggle"] = pg.locator("[data-testid=struck]").count()
    res["alc_struck"] = pg.locator("[data-testid=struck][data-rule=R-ALC]").count()
    pg.screenshot(path=f"{out}/{tag}-recovery-1440.png", full_page=True)
    # reload shows the same week
    names = pg.locator("[data-testid=slot-card] h3").all_inner_texts()
    pg.reload(wait_until="networkidle")
    res["reload_same"] = names == pg.locator("[data-testid=slot-card] h3").all_inner_texts()
    url = pg.url
    # 375 px
    m = b.new_context(viewport={"width": 375, "height": 812}, device_scale_factor=2, is_mobile=True, has_touch=True)
    mp = m.new_page()
    mp.goto(url, wait_until="networkidle")
    res["mobile_scroll_width"] = mp.evaluate("document.documentElement.scrollWidth")
    mp.screenshot(path=f"{out}/{tag}-recovery-375.png", full_page=True)
    mp.goto(base + "/", wait_until="networkidle")
    res["mobile_home_scroll_width"] = mp.evaluate("document.documentElement.scrollWidth")
    mp.screenshot(path=f"{out}/{tag}-home-375.png", full_page=True)
    mp.goto(base + "/integrations/qloo?plan=" + url.rsplit("/",1)[1], wait_until="networkidle")
    res["receipts_rows"] = mp.locator("tbody tr").count()
    res["mobile_receipts_scroll_width"] = mp.evaluate("document.documentElement.scrollWidth")
    mp.screenshot(path=f"{out}/{tag}-receipts-375.png", full_page=False)
    pg.goto(base + "/integrations/qloo", wait_until="networkidle")
    pg.screenshot(path=f"{out}/{tag}-receipts-1440.png", full_page=False)
    res["console_errors"] = errs
    b.close()
print(json.dumps(res, indent=1))
