#!/usr/bin/env python3
"""Manual audit of the bench's oracle (complexity.md L4 bias disclosure; build-plan D9).

The bench grades both arms with Qloo as the oracle. This script draws a sample the auditor checks against PUBLIC
sources instead (the venue's own site, its map listing, its menu), and summarises the verdicts.

  sample   draw 20 random arm-A outing venues + 20 random arm-B outing venues from bench/results.json (fixed seed),
           shuffle them together and write
             bench/manual_audit.csv      what the auditor sees: no arm column, no Qloo verdict
             the key                      audit_id -> arm, kept OUT of the repo until the external blind audit returns
                                          (default ../assets/audit/manual_audit_key.csv beside the project, or --key /
                                          $REKINDLE_AUDIT_KEY); committed with the audit summary once the verdicts are in
           Refuses to overwrite a CSV that already has verdicts unless --force.
  summary  join the filled CSV with the key -> bench/audit.json (per-arm rates; inconclusive rows are counted and
           left out of the denominator, never guessed).

Verdict columns (auditor fills): exists = yes | no | unclear ; open_at_slot = yes | no | unknown ;
serves_alcohol = yes | no | unknown (only matters for in_recovery = yes) ; source_url ; notes.
A row is WRONG when exists=no, or open_at_slot=no, or (in_recovery=yes and serves_alcohol=yes) — the killer-number
definition. It is CHECKED when it is wrong, or when exists=yes and open_at_slot=yes and (in_recovery=no or
serves_alcohol=no). Anything else is inconclusive.

Usage: python3 scripts/manual_audit.py sample [--n 20] [--seed 20261016] [--force]
       python3 scripts/manual_audit.py summary --auditor "..." --method "..."
"""
import argparse, csv, json, os, random, sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BENCH = os.path.join(ROOT, "bench")
CSV = os.path.join(BENCH, "manual_audit.csv")
# the answer key stays out of the public repo while the audit is blind (QA round 1); bench/ is the post-audit home
KEY_CANDIDATES = [os.environ.get("REKINDLE_AUDIT_KEY", ""), os.path.join(os.path.dirname(ROOT), "assets", "audit", "manual_audit_key.csv"), os.path.join(BENCH, "manual_audit_key.csv")]
KEY = next((k for k in KEY_CANDIDATES if k and os.path.exists(k)), KEY_CANDIDATES[1])
FIELDS = ["audit_id", "venue_name", "address", "locality", "day", "hour", "in_recovery", "exists", "open_at_slot", "serves_alcohol", "source_url", "notes"]


def sample(a):
    res = json.load(open(os.path.join(BENCH, "results.json")))
    profiles = {p["slug"]: p for p in json.load(open(os.path.join(ROOT, "fixtures", "profiles.json")))["profiles"]}
    if os.path.exists(CSV) and not a.force:
        with open(CSV) as f:
            if any(r.get("exists") for r in csv.DictReader(f)):
                sys.exit("bench/manual_audit.csv already has verdicts; pass --force to redraw")
    rng = random.Random(a.seed)
    rows = []
    for arm in ("A", "B"):
        pool = [v for v in res["venues"] if v["arm"] == arm and not v["classes"].get("error") and v.get("name")]
        pool.sort(key=lambda v: (v["profile"], v["day"], v["name"]))
        for v in rng.sample(pool, min(a.n, len(pool))):
            m = (v.get("verdict") or {}).get("match") or {}
            addr = v.get("stated_address") if arm == "A" else (v.get("address") or m.get("address") or "")
            rows.append({"arm": arm, "venue_name": v["name"], "address": addr or "", "locality": profiles[v["profile"]]["locality"], "day": v["day"], "hour": f"{int(v['hour']):02d}:00", "in_recovery": "yes" if v["in_recovery"] else "no"})
    rng.shuffle(rows)
    os.makedirs(os.path.dirname(KEY), exist_ok=True)
    with open(CSV, "w", newline="") as f, open(KEY, "w", newline="") as k:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        kw = csv.writer(k)
        w.writeheader()
        kw.writerow(["audit_id", "arm"])
        for i, r in enumerate(rows, 1):
            aid = f"AUD-{i:02d}"
            w.writerow({"audit_id": aid, **{x: r[x] for x in ("venue_name", "address", "locality", "day", "hour", "in_recovery")}, "exists": "", "open_at_slot": "", "serves_alcohol": "", "source_url": "", "notes": ""})
            kw.writerow([aid, r["arm"]])
    print(f"wrote {len(rows)} rows -> {os.path.relpath(CSV, ROOT)} (+ key {os.path.relpath(KEY, ROOT)})")


def verdict(r):
    ex, op, al, rec = (r.get("exists") or "").strip().lower(), (r.get("open_at_slot") or "").strip().lower(), (r.get("serves_alcohol") or "").strip().lower(), r.get("in_recovery") == "yes"
    wrong = ex == "no" or op == "no" or (rec and al == "yes")
    ok = ex == "yes" and op == "yes" and (not rec or al == "no")
    return {"wrong": wrong, "checked": wrong or ok, "not_found": ex == "no", "closed": op == "no", "alcohol": rec and al == "yes"}


def summary(a):
    key = {r["audit_id"]: r["arm"] for r in csv.DictReader(open(KEY))}
    rows = list(csv.DictReader(open(CSV)))
    arms = {}
    for r in rows:
        arm = key[r["audit_id"]]
        v = verdict(r)
        s = arms.setdefault(arm, {"sampled": 0, "checked": 0, "inconclusive": 0, "violations": 0, "rate": None, "not_found": 0, "closed_at_slot": 0, "alcohol": 0, "wrong_ids": []})
        s["sampled"] += 1
        if v["checked"]:
            s["checked"] += 1
        else:
            s["inconclusive"] += 1
        if v["wrong"]:
            s["violations"] += 1
            s["wrong_ids"].append(r["audit_id"])
        s["not_found"] += v["not_found"]
        s["closed_at_slot"] += v["closed"]
        s["alcohol"] += v["alcohol"]
    for s in arms.values():
        s["rate"] = round(s["violations"] / s["checked"], 4) if s["checked"] else None
    out = {
        "generated_by": "scripts/manual_audit.py summary",
        "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "bench/manual_audit.csv + bench/manual_audit_key.csv",
        "auditor": a.auditor,
        "method": a.method,
        "definition": "wrong = venue not found, or not open at the slot, or (in-recovery case) serves alcohol, per public sources; rate = wrong / checked; inconclusive rows are excluded from the denominator",
        "arms": arms,
    }
    with open(os.path.join(BENCH, "audit.json"), "w") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)
        f.write("\n")
    for arm, s in sorted(arms.items()):
        print(f"  {arm}: wrong {s['violations']}/{s['checked']} checked ({(s['rate'] or 0) * 100:.1f}%) · inconclusive {s['inconclusive']} · not found {s['not_found']} · closed {s['closed_at_slot']} · alcohol {s['alcohol']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["sample", "summary"])
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--seed", type=int, default=20261016)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--auditor", default="unspecified")
    ap.add_argument("--method", default="unspecified")
    a = ap.parse_args()
    (sample if a.cmd == "sample" else summary)(a)


if __name__ == "__main__":
    main()
