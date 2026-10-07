#!/usr/bin/env python3
"""The six failure/edge states (ui.md "States every component must render"; build-plan D10 gate), checked on a real
deployment from a fresh logged-out browser, starting from /judge as a judge would:
  loading (pencil skeleton while the live plan streams) · refused (struck candidates) · REVIEW (clinician-decides box)
  · empty (slot left empty with its reason) · coverage refusal (sparse-coverage profile, live) · Qloo unavailable
  (the labelled outage demo).
REVIEW depends on what Qloo returns that day: the script tries the profile /judge links for REVIEW, then Maya with
"in recovery" toggled on, and reports which one showed it. Nothing is mocked.
Usage: python3 scripts/edge_states.py <base-url> <screenshot-dir> [tag]   -> prints JSON; exits 1 on a failed state."""
import json, sys, time
from playwright.sync_api import sync_playwright

base, out = sys.argv[1].rstrip("/"), sys.argv[2]
tag = sys.argv[3] if len(sys.argv) > 3 else "local"
res, gates = {}, {}


def start(pg, testid):
    pg.goto(base + "/judge", wait_until="networkidle")
    pg.click(f"[data-testid={testid}]")
    pg.wait_for_url("**/cases/**", timeout=20000)


def done(pg):
    pg.wait_for_url("**/plans/**", timeout=90000)
    pg.wait_for_selector("[data-testid=ledger]")
    time.sleep(1)


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1440, "height": 1000})
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(base + "/judge", wait_until="networkidle")
    res["judge_states_listed"] = pg.locator("[data-testid=edge-states] > li").count()
    res["judge_bench_table_rows"] = pg.locator("[data-testid=bench-table] tbody tr").count()
    pg.screenshot(path=f"{out}/{tag}-judge-1440.png", full_page=True)

    # 1 loading + 2 refused (Maya, live)
    start(pg, "start-maya")
    pg.wait_for_selector("[data-testid=skeleton]", timeout=15000)
    gates["loading"] = pg.locator("[data-testid=skeleton]").count() > 0
    pg.screenshot(path=f"{out}/{tag}-state-loading-1440.png", full_page=False)
    done(pg)
    gates["refused"] = pg.locator("[data-testid=struck]").count() > 0
    res["maya_struck"] = pg.locator("[data-testid=struck]").count()
    res["maya_review"] = pg.locator("[data-testid=review]").count()
    pg.screenshot(path=f"{out}/{tag}-state-refused-1440.png", full_page=True)
    review_where = "maya" if res["maya_review"] else None
    if not review_where:
        pg.click("[data-testid=tab-in_recovery]")
        pg.wait_for_selector("[data-testid=toggle-notice]", timeout=60000)
        if pg.locator("[data-testid=review]").count():
            review_where = "maya + in recovery"

    # 3 REVIEW: the profile /judge links for it (from the committed bench run)
    if not review_where:
        pg.goto(base + "/judge", wait_until="networkidle")
        btns = pg.locator("[data-testid^=start-]:not([data-testid=start-maya]):not([data-testid=start-maya-outage])")
        ids = [btns.nth(i).get_attribute("data-testid") for i in range(btns.count())]
        for tid in ids:
            start(pg, tid)
            done(pg)
            if pg.locator("[data-testid=review]").count():
                review_where = tid.removeprefix("start-")
                break
    gates["review"] = bool(review_where)
    res["review_shown_on"] = review_where
    if review_where:
        pg.locator("[data-testid=review]").first.scroll_into_view_if_needed()
        pg.screenshot(path=f"{out}/{tag}-state-review-1440.png", full_page=False)

    # 4 empty + 5 coverage refusal (sparse-coverage profile, live)
    start(pg, "start-cal")
    done(pg)
    res["cal_empty"] = pg.locator("[data-testid=empty-slot]").count()
    gates["empty"] = res["cal_empty"] > 0
    gates["coverage_refusal"] = pg.locator("[data-testid=coverage-refusal]").count() == 1
    res["coverage_text"] = pg.locator("[data-testid=coverage-refusal]").inner_text()[:300] if gates["coverage_refusal"] else None
    res["widen_button"] = pg.locator("[data-testid=widen-radius]").count()
    pg.screenshot(path=f"{out}/{tag}-state-coverage-1440.png", full_page=True)

    # 6 Qloo unavailable (labelled outage demo)
    start(pg, "start-maya-outage")
    done(pg)
    res["outage_slots"] = pg.locator("[data-testid=qloo-unavailable]").count()
    gates["qloo_unavailable"] = pg.locator("[data-testid=outage-banner]").count() == 1 and res["outage_slots"] > 0
    res["outage_cards"] = pg.locator("[data-testid=slot-card]").count()
    pg.screenshot(path=f"{out}/{tag}-state-outage-1440.png", full_page=True)

    # mobile: the judge page and the outage sheet have no horizontal scroll
    mp = b.new_context(viewport={"width": 375, "height": 800}).new_page()
    mp.goto(base + "/judge", wait_until="networkidle")
    res["judge_375_scroll_width"] = mp.evaluate("document.documentElement.scrollWidth")
    mp.screenshot(path=f"{out}/{tag}-judge-375.png", full_page=False)
    res["page_errors"] = errs
    b.close()

gates["outage_fills_nothing"] = res["outage_cards"] == 0
gates["judge_375_no_scroll"] = res["judge_375_scroll_width"] <= 375
gates["no_page_errors"] = not res["page_errors"]
res["gates"] = gates
print(json.dumps(res, indent=1))
for k, v in gates.items():
    print(("PASS " if v else "FAIL ") + k)
sys.exit(0 if all(gates.values()) else 1)
