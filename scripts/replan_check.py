#!/usr/bin/env python3
"""Re-plan responsiveness (definitions in README "Bench"), LIVE against a deployment with the bench token.

For every arm-B week-1 plan in bench/results.json:
  N = profiles whose week 1 has >= 2 verified outings and >= 1 at-home card (the seed rating rule needs them);
      the others are excluded and named.
  rating rule (lib/replan.ts seedRatings): highest-affinity at-home card P7/M5, highest-affinity outing
      P8/M6, lowest-affinity outing P2/M3. The week is approved, rated and re-planned through the product's own routes
      (POST /approve, /ratings, /replan) — the same agent loop, tools and verifier as week 1.
  PASS for a profile when week 2
    (a) contains >= 1 entity that was not in week 1 whose TOP-weighted explainability input is a >= 7-rated entity
        (stronger than "named anywhere in explainability", which is near-automatic once a rated entity is a signal), and
    (b) contains 0 entities sharing an ID with the <= 3-rated one.
  Also reported per profile: the ember margin on each new card = (top rekindled weight) - (best original-love weight).
  a2a r11: PASS also at the ember thread's own margin (THREAD_MARGIN = lib/replan.ts EMBER_MIN_MARGIN, pinned by
  tests/judge-data.test.ts): (a) holds only when a new card's rekindled-top lead over the best original love is >= it —
  the rule the UI draws a thread by. `--rescore` recomputes it from the stored per-card margins (no live calls).

Usage: BENCH_TOKEN=... python3 scripts/replan_check.py --base https://rekindle.edycu.dev [--results bench/results.json] [--out bench/replan.json]
       python3 scripts/replan_check.py --rescore [--out bench/replan.json]   (offline: re-derive the summary from the stored rows)
"""
import argparse, json, os, re, statistics, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from store_guard import require_redis
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = "rekindle-bench/0.1 (+https://github.com/edycutjong/rekindle)"
THREAD_MARGIN = 0.02   # = EMBER_MIN_MARGIN (lib/replan.ts); tests/judge-data.test.ts fails if they differ


def call(base, token, method, path, body=None, timeout=120, sse=False):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(base + path, data=data, method=method, headers={"content-type": "application/json", "x-bench-token": token, "user-agent": UA, "accept": "text/event-stream" if sse else "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as res:
            txt, ctype, st = res.read().decode(), res.headers.get("content-type", ""), res.status
    except urllib.error.HTTPError as e:
        txt, ctype, st = e.read().decode(), e.headers.get("content-type", ""), e.code
    if "event-stream" in ctype:
        plan, err = None, None
        for frame in txt.split("\n\n"):
            m = re.search(r"^event: (.*)$", frame, re.M)
            d = re.search(r"^data: (.*)$", frame, re.M)
            if m and d and m.group(1) == "plan":
                plan = json.loads(d.group(1))["plan"]
            if m and d and m.group(1) == "error":
                err = json.loads(d.group(1))
        return st, {"plan": plan, "error": err}
    try:
        return st, json.loads(txt)
    except json.JSONDecodeError:
        return st, {"error": txt[:300]}


def seed_ratings(cards):
    home = sorted([c for c in cards if c["rung"] == "home"], key=lambda c: -c["affinity"])
    outs = sorted([c for c in cards if c["rung"] != "home"], key=lambda c: -c["affinity"])
    if len(outs) < 2 or len(home) < 1:
        return None
    return [(home[0], 7, 5), (outs[0], 8, 6), (outs[-1], 2, 3)]


def check(base, token, run, love_ids):
    pid = run["plan_id"]
    st, b = call(base, token, "GET", f"/api/plans/{pid}")
    if st != 200:
        return {"profile": run["profile"], "status": "error", "error": f"GET plan {st}"}
    w1 = b["plan"]
    rules = seed_ratings(w1["cards"])
    if rules is None:
        outs = len([c for c in w1["cards"] if c["rung"] != "home"])
        return {"profile": run["profile"], "status": "excluded", "reason": f"week 1 has {outs} verified outing(s); the rating rule needs >= 2"}
    if w1["status"] == "draft":
        st, b = call(base, token, "POST", f"/api/plans/{pid}/approve", {})
        if st != 200:
            return {"profile": run["profile"], "status": "error", "error": f"approve {st} {b}"}
    st, b = call(base, token, "POST", f"/api/plans/{pid}/ratings", {"ratings": [{"card_id": c["id"], "pleasure": p, "mastery": m} for c, p, m in rules]})
    if st != 200 and not (st == 409 and w1.get("next_plan_id")):
        return {"profile": run["profile"], "status": "error", "error": f"ratings {st} {b}"}
    t0 = time.time()
    st, b = call(base, token, "POST", f"/api/plans/{pid}/replan", {}, sse=True)
    secs = round(time.time() - t0, 2)
    w2 = b.get("plan")
    if not w2:
        return {"profile": run["profile"], "status": "error", "error": f"replan {st} {b.get('error')}"}
    high = {c["qloo_entity_id"]: c["name"] for c, p, _ in rules if p >= 7}
    low = {c["qloo_entity_id"] for c, p, _ in rules if p <= 3}
    w1_ids = {c["qloo_entity_id"] for c in w1["cards"]}
    new_cards, attributed, margins = [], [], []
    for c in w2["cards"]:
        if c["qloo_entity_id"] in w1_ids:
            continue
        ex = sorted(c["explain_json"], key=lambda x: -x["score"])
        top = ex[0] if ex else None
        best_rek = max([x["score"] for x in ex if x["entity_id"] in high], default=None)
        best_love = max([x["score"] for x in ex if x["entity_id"] in love_ids], default=None)
        margin = round(best_rek - best_love, 4) if best_rek is not None and best_love is not None else None
        is_top = bool(top and top["entity_id"] in high)
        new_cards.append({"name": c["name"], "rung": c["rung"], "top_input": top and top["name"], "top_score": top and top["score"], "rekindled_is_top": is_top, "margin": margin})
        if is_top:
            attributed.append(c["name"])
        if margin is not None:
            margins.append(margin)
    threaded = [c["name"] for c in new_cards if c["rekindled_is_top"] and c["margin"] is not None and c["margin"] >= THREAD_MARGIN]
    low_in_w2 = [c["name"] for c in w2["cards"] if c["qloo_entity_id"] in low]
    ok = len(attributed) >= 1 and not low_in_w2
    return {
        "profile": run["profile"], "status": "pass" if ok else "fail", "week1_plan": pid, "week2_plan": w2["id"], "replan_seconds": secs,
        "rated": [{"name": c["name"], "rung": c["rung"], "pleasure": p, "mastery": m} for c, p, m in rules],
        "week2_cards": len(w2["cards"]), "new_cards": len(new_cards), "attributed_new_cards": attributed, "threaded_new_cards": threaded, "low_rated_in_week2": low_in_w2,
        "margin_median": round(statistics.median(margins), 4) if margins else None, "margin_min": min(margins) if margins else None, "cards": new_cards,
        "diff_summary": {k: len(w2["diff"][k]) for k in ("kept", "added", "removed")} if w2.get("diff") else None,
    }


def rescore(out_path):
    """a2a r11: re-derive the summary from the stored per-profile rows; the run's own fields are kept"""
    d = json.load(open(out_path))
    d.update(summarise(d["profiles"]))
    d["profiles"] = d.pop("profiles")   # keep the rows last
    with open(out_path, "w") as f:
        json.dump(d, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(f"rescored {out_path}: {d['result']} · at the thread margin {d['passed_at_thread_margin']}/{d['N']} · threaded new cards {d['threaded_new_cards_total']} of {d['attributed_new_cards_total']} rating-led")


def main():
    if "--rescore" in sys.argv:
        i = sys.argv.index("--out") + 1 if "--out" in sys.argv else None
        return rescore(sys.argv[i] if i else os.path.join(ROOT, "bench", "replan.json"))
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--results", default=os.path.join(ROOT, "bench", "results.json"))
    ap.add_argument("--out", default=os.path.join(ROOT, "bench", "replan.json"))
    ap.add_argument("--workers", type=int, default=2)
    a = ap.parse_args()
    token = os.environ.get("BENCH_TOKEN") or sys.exit("BENCH_TOKEN is not set")
    base = a.base.rstrip("/")
    # a2a r06 F5: re-plans write plans; never on a Blob-backed deployment (scripts/store_guard.py)
    require_redis(base)
    res = json.load(open(a.results))
    profiles = {p["slug"]: p for p in json.load(open(os.path.join(ROOT, "fixtures", "profiles.json")))["profiles"]}
    runs = [p for p in res["plans"] if p["arm"] == "B"]
    started = datetime.now(timezone.utc).isoformat(timespec="seconds")

    def go(run):
        loves = {l["qloo_id"] for l in profiles[run["profile"]]["loves"] if l["qloo_kind"] == "entity"}
        r = check(base, token, run, loves)
        print(f"  {r['profile']:6} {r['status']:8} {r.get('reason') or r.get('error') or ('attributed ' + str(len(r['attributed_new_cards'])) + '/' + str(r['new_cards']) + ' new · margin median ' + str(r['margin_median']) + ' · ' + str(r['replan_seconds']) + ' s')}", flush=True)
        return r

    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        rows = list(ex.map(go, runs))
    out = {
        "generated_by": "scripts/replan_check.py",
        "started_at": started,
        "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "base": base,
        "source": os.path.relpath(a.results, ROOT),
        **summarise(rows),
        "profiles": rows,
    }
    with open(a.out, "w") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(f"\nRE-PLAN RESPONSIVENESS {out['result']} · at the thread margin {out['passed_at_thread_margin']}/{out['N']} · excluded {[x['profile'] for x in out['excluded']]} · errors {len(out['errors'])} · low-rated reappearing {out['low_rated_reappearing']} · attributed new cards {out['attributed_new_cards_total']}/{out['new_cards_total']} · margin median {out['ember_margin_median_of_profiles']} · wrote {a.out}")


def threaded_of(r):
    """rows written before a2a r11 lack threaded_new_cards: derive it from the stored per-card margins"""
    if "threaded_new_cards" in r:
        return r["threaded_new_cards"]
    return [c["name"] for c in r.get("cards", []) if c["rekindled_is_top"] and c["margin"] is not None and c["margin"] >= THREAD_MARGIN]


def summarise(rows):
    n = [r for r in rows if r["status"] in ("pass", "fail")]
    passed = [r for r in n if r["status"] == "pass"]
    for r in n:
        r["threaded_new_cards"] = threaded_of(r)
    passed_thread = [r for r in passed if r["threaded_new_cards"]]
    margins = [r["margin_median"] for r in n if r.get("margin_median") is not None]
    secs = [r["replan_seconds"] for r in n]
    return {
        "N": len(n),
        "passed": len(passed),
        "result": f"{len(passed)}/{len(n)}",
        "excluded": [{"profile": r["profile"], "reason": r["reason"]} for r in rows if r["status"] == "excluded"],
        "errors": [{"profile": r["profile"], "error": r["error"]} for r in rows if r["status"] == "error"],
        "failed": [r["profile"] for r in n if r["status"] == "fail"],
        "low_rated_reappearing": sum(len(r["low_rated_in_week2"]) for r in n),
        "attributed_new_cards_total": sum(len(r["attributed_new_cards"]) for r in n),
        "new_cards_total": sum(r["new_cards"] for r in n),
        "ember_margin_median_of_profiles": round(statistics.median(margins), 4) if margins else None,
        "ember_margin_min_of_profiles": min(margins) if margins else None,
        "replan_seconds_p50": sorted(secs)[max(0, -(-len(secs) // 2) - 1)] if secs else None,
        "thread_margin": THREAD_MARGIN,
        "passed_at_thread_margin": len(passed_thread),
        "threaded_new_cards_total": sum(len(r["threaded_new_cards"]) for r in n),
        "definition": "N = arm-B week-1 plans with >= 2 verified outings and >= 1 at-home card. PASS = week 2 has >= 1 new entity whose top-weighted explainability input is a >= 7-rated entity, and 0 entities with the <= 3-rated ID. margin = top rekindled weight - best original-love weight on a new card (Qloo's attribution, not a causal claim about the patient). PASS at the thread margin = PASS with at least one such card whose margin is at least " + f"{THREAD_MARGIN} (thread_margin), the lead the product draws an ember thread for.",
    }


if __name__ == "__main__":
    main()
