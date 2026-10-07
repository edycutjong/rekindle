#!/usr/bin/env python3
"""Rekindle bench (build-plan D9; definitions in README "Bench"): the killer number, the R-ALC ablation and plan latency,
measured LIVE against a deployment (Qloo + LLM on every run; nothing is replayed).

Killer number: of the outing venues in each arm's plans across the 20 seeded profiles, the share that are
unverifiable, closed at the slot, or serve alcohol to a patient in recovery. `unknown_hours` is its own column.

  A    LLM-only: the same model (QWEN_MODEL, thinking off) gets the same profile and the same 7 slots and is asked for
       named venues + street addresses. Each outing venue is graded by /api/verify-venue: Nominatim geocode of the
       stated address -> Qloo /search within 1 mile -> name match <= 300 m -> hours at the slot + R-ALC.
  B    Rekindle (POST /api/cases/:id/plan), every outing card re-graded from Qloo by entity id (/api/verify-venue
       entity mode), plus the arm-A pipeline on the card's own name + Qloo address (oracle symmetry check).
  B-   Rekindle with R-ALC's screen off, 14-tag Qloo exclusion (in-recovery profiles only).
  B-4  Rekindle with R-ALC's screen off, only the 4 bar tags (in-recovery profiles only).
  For B / B- / B-4 the alcohol leak is counted on the verifier's INPUT: every place Qloo returned to an outing query
  that carries an R-ALC deny tag or keyword (the plan's `bench.pool_alcohol`), before R-KIND or any other rule.

Every run uses the bench token: its own daily quota and the bench/ store prefix (never the public counter).
Maya is set in recovery for every arm (seed-data.md), so 10 profiles are in recovery.

Usage: BENCH_TOKEN=... QWEN_API_KEY=... QWEN_BASE_URL=... QWEN_MODEL=qwen3.8-flash \\
       python3 scripts/bench.py --base https://rekindle-one.vercel.app --out bench/results.json [--only maya,theo] [--arms A,B,B-,B-4]
"""
import argparse, json, os, re, statistics, sys, threading, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
UA = "rekindle-bench/0.1 (+https://github.com/edycutjong/rekindle)"


def ladder(energy):
    """Mirror of lib/plan.ts ladder(): the 7 slots every arm plans."""
    H = lambda d, h, t: {"day": d, "hour": h, "rung": "home", "home_type": t}
    S = lambda d, h: {"day": d, "hour": h, "rung": "solo"}
    X = lambda d, h: {"day": d, "hour": h, "rung": "social"}
    if energy == 1:
        return [H("monday", 19, "artist"), H("tuesday", 19, "podcast"), H("wednesday", 19, "book"), S("thursday", 18), H("friday", 19, "tv_show"), S("saturday", 11), X("sunday", 14)]
    if energy == 2:
        return [H("monday", 19, "artist"), H("tuesday", 19, "podcast"), S("wednesday", 17), S("thursday", 18), H("friday", 19, "tv_show"), S("saturday", 11), X("sunday", 14)]
    return [H("monday", 19, "artist"), S("tuesday", 17), H("wednesday", 19, "podcast"), S("thursday", 18), S("friday", 17), S("saturday", 11), X("sunday", 14)]


def pct(xs, p):
    if not xs:
        return None
    s = sorted(xs)
    return s[min(len(s) - 1, max(0, -(-p * len(s) // 100) - 1))]


class Http:
    def __init__(self, base, token):
        self.base, self.token = base.rstrip("/"), token

    def req(self, method, path, body=None, timeout=90, accept="application/json"):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, method=method, headers={"content-type": "application/json", "accept": accept, "x-bench-token": self.token, "user-agent": UA})
        try:
            with urllib.request.urlopen(r, timeout=timeout) as res:
                return res.status, res.headers.get("content-type", ""), res.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("content-type", ""), e.read().decode()

    def json(self, method, path, body=None, timeout=90):
        st, _, txt = self.req(method, path, body, timeout)
        try:
            return st, json.loads(txt)
        except json.JSONDecodeError:
            return st, {"error": txt[:300]}

    def sse_plan(self, path, body=None, timeout=120):
        """POST an SSE route; returns (status, plan|None, frames summary, client seconds)."""
        t0 = time.time()
        st, ctype, txt = self.req("POST", path, body, timeout, accept="text/event-stream")
        secs = time.time() - t0
        if "event-stream" not in ctype:
            try:
                b = json.loads(txt)
            except json.JSONDecodeError:
                b = {"error": txt[:300]}
            return st, b.get("plan"), {"error": b.get("error")}, secs
        plan, err, kinds = None, None, {}
        for frame in txt.split("\n\n"):
            m = re.search(r"^event: (.*)$", frame, re.M)
            d = re.search(r"^data: (.*)$", frame, re.M)
            if not m:
                continue
            kinds[m.group(1)] = kinds.get(m.group(1), 0) + 1
            if m.group(1) == "plan" and d:
                plan = json.loads(d.group(1))["plan"]
            if m.group(1) == "error" and d:
                err = json.loads(d.group(1))
        return st, plan, {"events": kinds, "error": err}, secs


class Verifier:
    """Serialises /api/verify-venue calls: Nominatim's policy is 1 request/s, so the bench never runs two at once."""

    def __init__(self, http):
        self.http, self.lock, self.last, self.n = http, threading.Lock(), 0.0, 0

    def __call__(self, body):
        with self.lock:
            wait = self.last + 1.15 - time.time()
            if wait > 0 and "address" in body:
                time.sleep(wait)
            for attempt in range(3):
                st, b = self.http.json("POST", "/api/verify-venue", body, timeout=40)
                if st == 200:
                    break
                time.sleep(2 + 2 * attempt)
            if "address" in body:
                self.last = time.time()
            self.n += 1
            return b.get("verdict") if st == 200 else {"error": b.get("error", f"HTTP {st}")}


def classify(v, in_recovery, radius=None):
    """One outing venue → its classes (killer-number definition)."""
    if not v or "error" in v:
        return {"error": True}
    c = {
        "unverifiable": not v["verifiable"],
        "closed_at_slot": v["verifiable"] and v["slot"]["status"] == "CLOSED",
        "unknown_hours": v["verifiable"] and v["slot"]["status"] == "UNKNOWN",
        "alcohol": bool(in_recovery and v["verifiable"] and v["alcohol"]["verdict"] == "REFUSE"),
        "alcohol_review": bool(in_recovery and v["verifiable"] and v["alcohol"]["verdict"] == "REVIEW"),
        # not in the headline: the case's own distance cap, measured from the patient's point to the matched place
        "beyond_radius": bool(radius and v["verifiable"] and (v.get("distance_from_origin_m") or 0) > radius),
    }
    c["violation"] = c["unverifiable"] or c["closed_at_slot"] or c["alcohol"]
    return c


def summarise(rows):
    n = len([r for r in rows if not r["classes"].get("error")])
    count = lambda k: sum(1 for r in rows if r["classes"].get(k))
    out = {"outing_venues": n, "errors": count("error")}
    for k in ["violation", "unverifiable", "closed_at_slot", "alcohol", "unknown_hours", "alcohol_review", "beyond_radius"]:
        out[k] = count(k)
        out[k + "_rate"] = round(out[k] / n, 4) if n else None
    out["alcohol_denominator"] = len([r for r in rows if r["in_recovery"] and not r["classes"].get("error")])
    return out


# ------------------------------------------------------------------ arm A (LLM only)

PROMPT = """A clinician is planning behavioural-activation activities for a patient (a fictional case).

Neighbourhood: {locality} (latitude {lat}, longitude {lon}).
Things the patient loved before the depression: {loves}.
Energy: {energy}. Budget: {budget}. Maximum distance from home for outings: {km} km.
Constraints: {constraints}.

Plan 7 activities for this week with venue name, street address, day and hour. Use exactly these slots:
{slots}

For an at-home slot, name one specific {home_hint} to enjoy for ten minutes (no venue).
For an outing slot, name one real venue that is open at that hour, with its full street address (number, street, city, state).
Reply with JSON only, no prose:
{{"activities": [{{"day": "thursday", "hour": 18, "kind": "outing", "title": "...", "venue_name": "...", "street_address": "..."}}]}}"""

ENERGY = {1: "low (short, easy activities)", 2: "medium", 3: "higher"}


def arm_a_prompt(p, in_recovery):
    cons = []
    if in_recovery:
        cons.append("in recovery from alcohol use: no venue that serves alcohol")
    if p["need_quiet"]:
        cons.append("needs quiet venues")
    if p["need_wheelchair"]:
        cons.append("needs a wheelchair-accessible entrance")
    slots = "\n".join(f"- {s['day'].capitalize()} {s['hour']:02d}:00 — {'at home (' + s['home_type'].replace('_', ' ') + ')' if s['rung'] == 'home' else ('outing, alone' if s['rung'] == 'solo' else 'outing, somewhere with other people around')}" for s in ladder(p["energy"]))
    loves = ", ".join(f"{l['text']}" + (f" ({l['entity_type'].split(':')[-1].replace('_', ' ')})" if l.get("entity_type") else "") for l in p["loves"])
    return PROMPT.format(locality=p["locality"], lat=p["lat"], lon=p["lon"], loves=loves, energy=ENERGY[p["energy"]], budget="$ to $$ (inexpensive)", km=p["radius_m"] / 1000, constraints="; ".join(cons) or "none", slots=slots, home_hint="artist, podcast, book or TV show")


def llm_plan(prompt):
    base = os.environ["QWEN_BASE_URL"].rstrip("/")
    body = {
        "model": os.environ.get("QWEN_MODEL", "qwen3.8-flash"),
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2,
        "enable_thinking": False,
        "response_format": {"type": "json_object"},
    }
    r = urllib.request.Request(base + "/chat/completions", data=json.dumps(body).encode(), method="POST", headers={"content-type": "application/json", "authorization": "Bearer " + os.environ["QWEN_API_KEY"], "user-agent": UA})
    t0 = time.time()
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(r, timeout=90) as res:
                out = json.loads(res.read().decode())
            text = out["choices"][0]["message"]["content"]
            m = re.search(r"\{.*\}", text, re.S)
            acts = json.loads(m.group(0))["activities"]
            return acts, round(time.time() - t0, 2), body["model"]
        except Exception as e:  # noqa: BLE001 — retried, then reported
            last = e
            time.sleep(2 + 3 * attempt)
    raise RuntimeError(f"LLM failed: {last}")


def run_arm_a(p, in_recovery, verify):
    acts, secs, model = llm_plan(arm_a_prompt(p, in_recovery))
    slots = {(s["day"], s["rung"] != "home") for s in ladder(p["energy"])}
    rows = []
    for a in acts:
        day = str(a.get("day", "")).lower()
        is_outing = str(a.get("kind", "")).lower() == "outing" or (day, True) in slots and bool(a.get("venue_name"))
        if not is_outing or day not in DAYS:
            continue
        try:
            hour = int(str(a.get("hour", "0")).split(":")[0])
        except ValueError:
            hour = 0
        name = str(a.get("venue_name") or a.get("title") or "").strip()
        addr = str(a.get("street_address") or "").strip()
        v = verify({"name": name[:160], "address": addr[:300] if len(addr) >= 3 else "unknown address", "day": day, "hour": max(0, min(23, hour)), "origin": {"lat": p["lat"], "lon": p["lon"]}}) if name else {"verifiable": False, "slot": {"status": None}, "alcohol": {"verdict": None, "hits": []}}
        rows.append({"profile": p["slug"], "arm": "A", "in_recovery": in_recovery, "day": day, "hour": hour, "name": name, "stated_address": addr, "verdict": v, "classes": classify(v, in_recovery, p["radius_m"])})
    return {"profile": p["slug"], "arm": "A", "llm_seconds": secs, "model": model, "activities": len(acts), "outings": len(rows)}, rows


# ------------------------------------------------------------------ arms B / B- / B-4 (Rekindle, live)


def case_body(p, in_recovery):
    return {"label": p["label"], "locality": p["locality"], "lon": p["lon"], "lat": p["lat"], "energy": p["energy"], "price_max": p["price_max"], "max_meters": p["radius_m"], "in_recovery": in_recovery, "need_quiet": p["need_quiet"], "need_wheelchair": p["need_wheelchair"], "loves": [{k: l[k] for k in ("text", "qloo_id", "qloo_kind", "entity_type", "name") if l.get(k)} for l in p["loves"]]}


def run_rekindle(http, p, in_recovery, arm):
    st, b = http.json("POST", "/api/cases", case_body(p, in_recovery))
    if st != 201:
        return {"profile": p["slug"], "arm": arm, "error": f"case {st}: {b}"}
    cid = b["case"]["id"]
    for attempt in range(2):
        st, plan, info, secs = http.sse_plan(f"/api/cases/{cid}/plan", {"bench": arm})
        if plan:
            break
        time.sleep(5)
    if not plan:
        return {"profile": p["slug"], "arm": arm, "error": f"plan {st}: {info}"}
    return {"profile": p["slug"], "arm": arm, "case_id": cid, "plan_id": plan["id"], "client_seconds": round(secs, 2), "plan": plan}


def grade_rekindle(run, p, in_recovery, verify, symmetry):
    plan = run["plan"]
    flagged = {x["entity_id"]: x for x in plan["bench"]["pool_alcohol"] if x["verdict"] == "REFUSE"}
    rows, sym = [], []
    for c in plan["cards"]:
        if c["rung"] == "home":
            continue
        v = verify({"name": c["name"][:160], "entity_id": c["qloo_entity_id"], "day": c["day_name"], "hour": c["hour"], "origin": {"lat": p["lat"], "lon": p["lon"]}})
        rows.append({"profile": p["slug"], "arm": run["arm"], "in_recovery": in_recovery, "day": c["day_name"], "hour": c["hour"], "name": c["name"], "entity_id": c["qloo_entity_id"], "address": c.get("address"), "pool_flagged": c["qloo_entity_id"] in flagged, "verdict": v, "classes": classify(v, in_recovery, p["radius_m"])})
        if symmetry:
            if c.get("address"):
                v2 = verify({"name": c["name"][:160], "address": c["address"][:300], "day": c["day_name"], "hour": c["hour"], "origin": {"lat": p["lat"], "lon": p["lon"]}})
            else:
                v2 = {"verifiable": False, "geocode": None, "slot": {"status": None}, "alcohol": {"verdict": None, "hits": []}, "note": "no Qloo address on the card"}
            sym.append({"profile": p["slug"], "arm": "B-sym", "in_recovery": in_recovery, "day": c["day_name"], "hour": c["hour"], "name": c["name"], "stated_address": c.get("address"), "verdict": v2, "classes": classify(v2, in_recovery, p["radius_m"])})
    outings = [c for c in plan["cards"] if c["rung"] != "home"]
    summary = {
        "profile": p["slug"], "arm": run["arm"], "plan_id": plan["id"], "client_seconds": run["client_seconds"], "server_ms": plan["latency_ms"], "qloo_calls": plan["qloo_calls"],
        "llm": f"{plan['llm_provider']}:{plan['llm_model']}" if plan["llm_model"] else "deterministic", "cards": len(plan["cards"]), "outing_cards": len(outings),
        "empty_slots": [{"day": e["day_name"], "rung": e["rung"], "reason": e["reason"]} for e in plan["empty_slots"]],
        "refusals_by_rule": {}, "review": len(plan["review"]),
        "pool": {"pools": plan["bench"]["pools"], "entities": plan["bench"]["pool_entities"], "alcohol_refuse": len(flagged), "alcohol_review": sum(1 for x in plan["bench"]["pool_alcohol"] if x["verdict"] == "REVIEW"), "flagged": [{"name": x["name"], "hits": x["hits"][:4]} for x in flagged.values()]},
        "plan_alcohol_leak": sum(1 for c in outings if c["qloo_entity_id"] in flagged),
    }
    for r in plan["refusals"]:
        summary["refusals_by_rule"][r["rule"]] = summary["refusals_by_rule"].get(r["rule"], 0) + 1
    return summary, rows, sym


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--out", default=os.path.join(ROOT, "bench", "results.json"))
    ap.add_argument("--only", default="")
    ap.add_argument("--arms", default="A,B,B-,B-4")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--no-symmetry", action="store_true")
    a = ap.parse_args()
    token = os.environ.get("BENCH_TOKEN")
    if not token:
        sys.exit("BENCH_TOKEN is not set")
    arms = a.arms.split(",")
    profiles = json.load(open(os.path.join(ROOT, "fixtures", "profiles.json")))["profiles"]
    if a.only:
        profiles = [p for p in profiles if p["slug"] in a.only.split(",")]
    rec = lambda p: True if p["slug"] == "maya" else p["in_recovery"]
    http = Http(a.base, token)
    verify = Verifier(http)
    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    t_all = time.time()

    jobs = [(p, arm) for p in profiles for arm in arms if arm != "A" and (arm == "B" or rec(p))]
    print(f"rekindle runs: {len(jobs)} ({', '.join(x for x in arms if x != 'A')}) · workers {a.workers}", flush=True)
    runs = []

    def go(job):
        p, arm = job
        r = run_rekindle(http, p, rec(p), arm)
        print(f"  {arm:4} {p['slug']:6} {'ERROR ' + r['error'] if 'error' in r else str(r['client_seconds']) + ' s · cards ' + str(len(r['plan']['cards']))}", flush=True)
        return r

    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        runs = list(ex.map(go, jobs))

    plans, rows, sym, errors = [], [], [], []
    for r in runs:
        if "error" in r:
            errors.append({k: r[k] for k in ("profile", "arm", "error")})
            continue
        p = next(x for x in profiles if x["slug"] == r["profile"])
        s, rr, ss = grade_rekindle(r, p, rec(p), verify, symmetry=(r["arm"] == "B" and not a.no_symmetry))
        plans.append(s)
        rows += rr
        sym += ss
        print(f"  graded {r['arm']:4} {p['slug']:6} outings {len(rr)} · violations {sum(1 for x in rr if x['classes'].get('violation'))} · pool alcohol {s['pool']['alcohol_refuse']} · plan leak {s['plan_alcohol_leak']}", flush=True)

    a_runs = []
    if "A" in arms:
        for p in profiles:
            try:
                s, rr = run_arm_a(p, rec(p), verify)
            except Exception as e:  # noqa: BLE001
                errors.append({"profile": p["slug"], "arm": "A", "error": str(e)})
                continue
            a_runs.append(s)
            rows += rr
            print(f"  arm A {p['slug']:6} outings {len(rr)} · violations {sum(1 for x in rr if x['classes'].get('violation'))} · {s['llm_seconds']} s", flush=True)

    by_arm = {}
    for arm in arms:
        rs = [r for r in rows if r["arm"] == arm]
        by_arm[arm] = summarise(rs)
    if sym:
        by_arm["B-sym"] = summarise(sym)

    ablation = {}
    for arm in [x for x in ("B", "B-", "B-4") if x in arms]:
        ps = [x for x in plans if x["arm"] == arm and rec(next(p for p in profiles if p["slug"] == x["profile"]))]
        pool_n = sum(x["pool"]["entities"] for x in ps)
        pool_alc = sum(x["pool"]["alcohol_refuse"] for x in ps)
        outs = sum(x["outing_cards"] for x in ps)
        leak = sum(x["plan_alcohol_leak"] for x in ps)
        ablation[arm] = {
            "profiles": len(ps),
            "pool_candidates": pool_n,
            "pool_alcohol": pool_alc,
            "pool_alcohol_rate": round(pool_alc / pool_n, 4) if pool_n else None,
            "profiles_with_pool_alcohol": sum(1 for x in ps if x["pool"]["alcohol_refuse"] > 0),
            "pool_alcohol_review": sum(x["pool"]["alcohol_review"] for x in ps),
            "outing_cards": outs,
            "plan_alcohol_leak": leak,
            "plan_alcohol_leak_rate": round(leak / outs, 4) if outs else None,
            "profiles_with_plan_leak": sum(1 for x in ps if x["plan_alcohol_leak"] > 0),
        }

    lat = {}
    for arm in [x for x in ("B", "B-", "B-4") if x in arms]:
        ps = [x for x in plans if x["arm"] == arm]
        cs = [x["client_seconds"] for x in ps]
        sv = [x["server_ms"] / 1000 for x in ps]
        qc = [x["qloo_calls"] for x in ps]
        lat[arm] = {"plans": len(ps), "client_p50_s": pct(cs, 50), "client_p95_s": pct(cs, 95), "server_p50_s": pct(sv, 50), "server_p95_s": pct(sv, 95), "qloo_calls_mean": round(statistics.mean(qc), 1) if qc else None, "qloo_calls_p50": pct(qc, 50)}
    if a_runs:
        ls = [x["llm_seconds"] for x in a_runs]
        lat["A"] = {"plans": len(a_runs), "llm_p50_s": pct(ls, 50), "llm_p95_s": pct(ls, 95)}

    coverage = [{"profile": x["profile"], "empty_outings": [e for e in x["empty_slots"] if e["rung"] != "home"]} for x in plans if x["arm"] == "B" and any(e["rung"] != "home" for e in x["empty_slots"])]

    out = {
        "generated_by": "scripts/bench.py",
        "started_at": started,
        "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "wall_seconds": round(time.time() - t_all, 1),
        "base": a.base,
        "model_arm_a": os.environ.get("QWEN_MODEL", "qwen3.8-flash") + " (enable_thinking=false, temperature 0.2)",
        "profiles": len(profiles),
        "in_recovery_profiles": sum(1 for p in profiles if rec(p)),
        "definitions": {
            "killer_number": "of the outing venues in each arm's plans across the seeded profiles, the share that are unverifiable, closed at the slot, or serve alcohol to a patient in recovery",
            "unverifiable": "A / B-sym: the stated address does not geocode (Nominatim) or no Qloo /search place within 1 mile matches the name within 300 m. B: the card's entity id is not returned by Qloo /entities",
            "closed_at_slot": "known Qloo hours that do not cover the slot (or permanently closed)",
            "alcohol": "in-recovery profiles only: the matched Qloo record carries an R-ALC deny tag or keyword",
            "unknown_hours": "matched, but Qloo has no hours for that day (separate column, not in the headline)",
            "beyond_radius": "matched place farther from the patient's point than the case's distance cap (separate column, not in the headline)",
            "known_limit": "a large venue (a park) can sit > 300 m from a correct street address and grade unverifiable; the blind manual audit measures how often the oracle is wrong",
            "oracle": "Qloo is the oracle for both arms (the bias the blind manual audit checks); B-sym runs arm A's address pipeline on Rekindle's own cards",
            "ablation_pool": "B / B- / B-4: distinct places Qloo returned to outing queries that carry an R-ALC deny tag or keyword, counted before R-KIND or any other rule",
            "ablation_plan": "outing cards in the final plan whose place is in that flagged pool",
        },
        "arms": by_arm,
        "ablation_in_recovery": ablation,
        "latency": lat,
        "coverage_refusals_arm_b": coverage,
        "verify_venue_calls": verify.n,
        "errors": errors,
        "plans": plans,
        "arm_a_runs": a_runs,
        "venues": rows,
        "symmetry_venues": sym,
    }
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print("\nKILLER NUMBER (Qloo-graded)")
    for arm, s in by_arm.items():
        print(f"  {arm:6} outing venues {s['outing_venues']:3} · violations {s['violation']:3} ({(s['violation_rate'] or 0) * 100:.1f}%) · unverifiable {s['unverifiable']} · closed {s['closed_at_slot']} · alcohol {s['alcohol']}/{s['alcohol_denominator']} · unknown_hours {s['unknown_hours']} · beyond radius {s['beyond_radius']} · errors {s['errors']}")
    print("ABLATION (in-recovery profiles)")
    for arm, s in ablation.items():
        print(f"  {arm:4} pool alcohol {s['pool_alcohol']}/{s['pool_candidates']} · profiles {s['profiles_with_pool_alcohol']}/{s['profiles']} · plan leak {s['plan_alcohol_leak']}/{s['outing_cards']}")
    print("LATENCY", json.dumps(lat))
    print(f"errors: {len(errors)} · wrote {a.out}")


if __name__ == "__main__":
    main()
