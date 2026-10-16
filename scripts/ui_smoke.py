#!/usr/bin/env python3
"""Logged-out end-to-end run of the ONE flow, Playwright against a real deployment:
home -> Plan Maya (live) -> week renders -> "In recovery" toggle -> reload shows the same week -> clinician gate
(swap one card live, approve one card, approve the week -> stamp) -> rate 3 activities (P/M) -> re-plan week 2 (live)
-> diff + ember underline + ember threads (top rated input over the best original love) -> reload keeps week 2 -> week 1 links to week 2 ->
375 px has no horizontal scroll -> /integrations/qloo lists the calls.
Usage: python3 scripts/ui_smoke.py <base-url> <screenshot-dir> [tag]   (needs Playwright: `python3 -m venv .venv && . .venv/bin/activate && pip install playwright && playwright install chromium`).
Exits 1 if any gate assertion fails. It drives the real deployment; nothing is mocked.
It spends 2 plan runs (week 1 and the re-plan) and 2 toggle-class calls (In recovery, one swap). Past the deployment's
rate limit (lib/ratelimit.ts) the app shows "Capacity reached"; the smoke then prints "CAPPED at <step>" and exits 3:
that is the limit, not a failed gate. REKINDLE_JUDGE_TOKEN=<token from the Devpost judge link> runs on the judge quota."""
import json, os, re, sys, time
from store_guard import require_redis

# a2a r06 F5: the smoke writes ~6 plans; never on a Blob-backed deployment (checked before playwright even loads)
require_redis(sys.argv[1])
from playwright.sync_api import sync_playwright  # noqa: E402

ALC = re.compile(r"\b(drinks?|beers?|wines?|cocktails?|bars?)\b", re.I)
base = sys.argv[1]; out = sys.argv[2]; tag = sys.argv[3] if len(sys.argv) > 3 else "local"
res = {}
CAPPED = 3  # a2a r12: a rate limit is not a failed gate
ALERTS = "[...document.querySelectorAll('[role=alert]')].map((n) => n.innerText).join(' ')"


def wait_or_capped(pg, js, step, timeout):
    """wait for `js`, or for the app's capped screen (a 429 from lib/ratelimit.ts); on the latter print it and exit 3"""
    pg.wait_for_function(f"() => /capacity reached|too many requests/i.test({ALERTS}) || ({js})", timeout=timeout)
    text = " ".join(pg.evaluate(f"() => {ALERTS}").split())
    if re.search(r"capacity reached|too many requests", text, re.I):
        print(f"CAPPED at {step}: {text}")
        print("This is the deployment's rate limit (each response carries x-ratelimit-* headers), not a failed gate.")
        sys.exit(CAPPED)


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1440, "height": 1000})  # fresh context = logged-out, no cookies
    pg = ctx.new_page()
    errs = []
    pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
    pg.on("pageerror", lambda e: errs.append(str(e)))
    if os.environ.get("REKINDLE_JUDGE_TOKEN"):
        # the judge link from the Devpost testing instructions: sets the judge cookie, so these runs use the judge quota
        pg.goto(base + "/?judge=" + os.environ["REKINDLE_JUDGE_TOKEN"], wait_until="networkidle")
    t0 = time.time()
    pg.goto(base + "/", wait_until="networkidle")
    pg.screenshot(path=f"{out}/{tag}-home-1440.png", full_page=True)
    pg.click("[data-testid=start-maya]")
    wait_or_capped(pg, "location.pathname.includes('/cases/')", "Maya's case (its week-1 plan starts on arrival)", 20000)
    time.sleep(6)
    pg.screenshot(path=f"{out}/{tag}-streaming-1440.png", full_page=True)
    wait_or_capped(pg, "location.pathname.includes('/plans/')", "planning week 1", 90000)
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
    wait_or_capped(pg, "!!document.querySelector('[data-testid=toggle-notice]')", "the In recovery toggle", 60000)
    res["toggle_notice"] = pg.locator("[data-testid=toggle-notice]").inner_text()
    res["toggle_url"] = pg.url
    res["struck_after_toggle"] = pg.locator("[data-testid=struck]").count()
    res["alc_struck"] = pg.locator("[data-testid=struck][data-rule=R-ALC]").count()
    # COACH-ALC (QA round 1): no coaching line on the in-recovery week mentions drinking
    res["coach_lines_after_recovery"] = pg.locator("[data-testid=coach]").all_inner_texts()
    res["coach_alcohol_after_recovery"] = [t for t in res["coach_lines_after_recovery"] if ALC.search(t)]
    pg.screenshot(path=f"{out}/{tag}-recovery-1440.png", full_page=True)
    # reload shows the same week
    names = pg.locator("[data-testid=slot-card] h3").all_inner_texts()
    pg.reload(wait_until="networkidle")
    res["reload_same"] = names == pg.locator("[data-testid=slot-card] h3").all_inner_texts()
    url = pg.url
    # ---- clinician gate (D7): swap one card live, approve one card, approve the week
    cards = pg.locator("[data-testid=slot-card]")
    before_swap = cards.nth(0).locator("h3").inner_text()
    t = time.time()
    cards.nth(0).locator("[data-testid=card-swap]").click()
    wait_or_capped(pg, "(() => { const n = document.querySelector('[data-testid=toggle-notice]'); return !!n && /Swapped|No other verified/.test(n.textContent) })()", "the swap", 60000)
    res["swap_seconds"] = round(time.time() - t, 1)
    res["swap_notice"] = pg.locator("[data-testid=toggle-notice]").inner_text()
    res["swap_changed"] = before_swap not in [x for x in pg.locator("[data-testid=slot-card] h3").all_inner_texts()]
    res["clinician_strikes"] = pg.locator("[data-testid=struck][data-rule=CLINICIAN]").count()
    res["swapped_out"] = before_swap
    pg.locator("[data-testid=slot-card]").nth(1).locator("[data-testid=card-approve]").click()
    pg.wait_for_selector("[data-testid=slot-card][data-approved=true]", timeout=20000)
    pg.screenshot(path=f"{out}/{tag}-gate-1440.png", full_page=True)
    pg.click("[data-testid=approve-week]")
    pg.wait_for_selector("[data-testid=stamp]", timeout=20000)
    res["stamp"] = pg.locator("[data-testid=stamp]").inner_text()
    res["approved_cards"] = pg.locator("[data-testid=slot-card][data-approved=true]").count()
    res["cards_after_gate"] = pg.locator("[data-testid=slot-card]").count()
    # ---- ratings (D7): P/M on three activities; re-plan enabled at >= 3
    rated = pg.locator("[data-testid=slot-card]")
    n = rated.count()
    plan_ratings = [(0, 8, 5), (1, 9, 6), (n - 1, 2, 3)]
    res["replan_enabled_before"] = pg.locator("[data-testid=replan]").is_enabled()
    for i, p_, m_ in plan_ratings:
        rated.nth(i).locator("[data-testid=rate-p]").fill(str(p_))
        rated.nth(i).locator("[data-testid=rate-m]").fill(str(m_))
    res["rated_count"] = pg.locator("[data-testid=rated-count]").inner_text().strip()
    res["replan_enabled_after"] = pg.locator("[data-testid=replan]").is_enabled()
    res["rated_names"] = {rated.nth(i).locator("h3").inner_text(): p_ for i, p_, m_ in plan_ratings}
    pg.screenshot(path=f"{out}/{tag}-ratings-1440.png", full_page=True)
    week1_url = pg.url
    # ---- re-plan week 2 (live) + diff + ember
    t = time.time()
    pg.click("[data-testid=replan]")
    wait_or_capped(pg, "!!document.querySelector('[data-testid=replan-diff]')", "the week-2 re-plan", 90000)
    pg.wait_for_function("() => !document.querySelector('[aria-busy=true]') && document.querySelectorAll('[data-testid=slot-card]').length > 0", timeout=90000)
    res["replan_seconds_from_click"] = round(time.time() - t, 1)
    time.sleep(1)
    res["week2_url"] = pg.url
    res["week2_heading"] = pg.locator("h1").first.inner_text()
    res["week2_cards"] = pg.locator("[data-testid=slot-card]").count()
    res["rekindled_underlined"] = pg.locator("[data-testid=rekindled]").count()
    res["ember_labels"] = pg.locator("[data-testid=ember-label]").all_inner_texts()
    res["ember_thread_paths"] = pg.locator("[data-testid=ember-threads] path").count()
    res["ember_tied_labels"] = pg.locator("[data-testid=ember-tied]").all_inner_texts()
    res["diff_summary"] = pg.locator("[data-testid=replan-summary] p").first.inner_text()
    res["leaving_out"] = pg.locator("[data-testid=replan-summary] .leaving-out li, [data-testid=replan-summary] li").all_inner_texts()
    res["kept_notes"] = pg.locator("[data-testid=kept-note]").all_inner_texts()
    res["kept_labels"] = pg.locator("[data-testid=kept-label]").all_inner_texts()
    res["signal_list"] = pg.locator("[data-testid=signal-list] li").all_inner_texts()
    res["week2_names"] = pg.locator("[data-testid=slot-card] h3").all_inner_texts()
    pg.screenshot(path=f"{out}/{tag}-replan-1440.png", full_page=True)
    w2names = pg.locator("[data-testid=slot-card] h3").all_inner_texts()
    pg.reload(wait_until="networkidle")
    res["week2_reload_same"] = w2names == pg.locator("[data-testid=slot-card] h3").all_inner_texts() and pg.locator("[data-testid=replan-diff]").count() == 1
    week2_url = pg.url
    pg.goto(week1_url, wait_until="networkidle")
    res["week1_links_week2"] = pg.locator("[data-testid=next-week]").count() == 1 and pg.locator("[data-testid=pm-locked]").count() > 0
    # ---- patient print view: approved cards only, no weights / rule IDs / strikes
    week1_cards = pg.locator("[data-testid=slot-card]").count()
    pg.click("[data-testid=print-link]")
    pg.wait_for_selector("[data-testid=print-sheet]", timeout=20000)
    res["print_rows"] = pg.locator("[data-testid=print-row]").count()
    print_text = pg.locator("[data-testid=print-sheet]").inner_text()
    res["print_alcohol"] = bool(ALC.search(print_text))
    res["print_has_weights_or_rules"] = bool(re.search(r"\b0\.\d\d\b|R-[A-Z]{2,}|because ", print_text))
    pg.emulate_media(media="print")
    res["print_button_hidden_in_print"] = not pg.locator("[data-testid=print-button]").is_visible()
    pg.screenshot(path=f"{out}/{tag}-print-1440.png", full_page=True)
    pg.emulate_media(media="screen")
    print_url = pg.url
    # 375 px
    m = b.new_context(viewport={"width": 375, "height": 812}, device_scale_factor=2, is_mobile=True, has_touch=True)
    mp = m.new_page()
    mp.goto(url, wait_until="networkidle")
    res["mobile_scroll_width"] = mp.evaluate("document.documentElement.scrollWidth")
    mp.screenshot(path=f"{out}/{tag}-recovery-375.png", full_page=True)
    mp.goto(week2_url, wait_until="networkidle")
    res["mobile_replan_scroll_width"] = mp.evaluate("document.documentElement.scrollWidth")
    res["mobile_ember_labels"] = mp.locator("[data-testid=ember-label]").count()
    mp.screenshot(path=f"{out}/{tag}-replan-375.png", full_page=True)
    mp.goto(print_url, wait_until="networkidle")
    res["mobile_print_scroll_width"] = mp.evaluate("document.documentElement.scrollWidth")
    mp.screenshot(path=f"{out}/{tag}-print-375.png", full_page=True)
    mp.goto(base + "/", wait_until="networkidle")
    res["mobile_home_scroll_width"] = mp.evaluate("document.documentElement.scrollWidth")
    res["mobile_header_height"] = mp.evaluate("document.querySelector('header').getBoundingClientRect().height")
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
gates = {
    "week 1: 7 cards, every card has a why line": res["cards"] == 7 and res["why"] == 7,
    "reload shows the same week": res["reload_same"],
    "swap re-ran one slot": res["swap_changed"] or "No other verified" in res["swap_notice"],
    "approve week stamps every card": res["approved_cards"] == res["cards_after_gate"] and res["stamp"].lower().startswith("approved"),
    "re-plan disabled < 3 rated, enabled at 3": (not res["replan_enabled_before"]) and res["replan_enabled_after"],
    "week 2 re-planned with a diff": res["week2_heading"].startswith("Week 2") and res["week2_cards"] > 0,
    "ember underline on the >= 7 activities": res["rekindled_underlined"] == 2,
    "ember threads only where a rating leads the loves (one per card)": res["ember_thread_paths"] == len(res["ember_labels"]),
    # QA round 3: a "because of" label always shows a lead >= 0.020; ties say "tied with" and carry no thread
    "ember 'because of' only on a lead >= 0.02": all(re.search(r"\+0\.(\d{3})", t) and int(re.search(r"\+0\.(\d{3})", t).group(1)) >= 20 for t in res["ember_labels"]) and all("because of" not in t for t in res["ember_tied_labels"]),
    "week 2 survives a reload": res["week2_reload_same"],
    "week 1 locked and links to week 2": res["week1_links_week2"],
    "patient sheet prints the approved week only, without weights or rule IDs": res["print_rows"] == week1_cards and not res["print_has_weights_or_rules"] and res["print_button_hidden_in_print"],
    "no horizontal scroll at 375 px": max(res["mobile_scroll_width"], res["mobile_replan_scroll_width"], res["mobile_home_scroll_width"], res["mobile_print_scroll_width"]) <= 375,
    "header is at most two rows at 375 px": res["mobile_header_height"] <= 112,
    "no console errors": not res["console_errors"],
    "in recovery: no coaching line mentions drinking (COACH-ALC)": not res["coach_alcohol_after_recovery"],
    "the card the clinician swapped out is not in week 2": res["swapped_out"] not in res["week2_names"],
    "rated >=7 is kept or listed as a signal, never under 'Leaving out'": not any("≥7" in x for x in res["leaving_out"] if x not in res["signal_list"]) and (len(res["kept_labels"]) + len(res["signal_list"])) >= 1,
}
for k, v in gates.items():
    print(("PASS " if v else "FAIL ") + k)
sys.exit(0 if all(gates.values()) else 1)
