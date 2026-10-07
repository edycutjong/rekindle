#!/usr/bin/env python3
"""Write the bench numbers into README.md, DEMO.md and JUDGE.md from the committed bench files — never by hand.

Sources: bench/results.json (scripts/bench.py), bench/replan.json (scripts/replan_check.py),
bench/audit.json (scripts/manual_audit.py summary). Each target file carries marker pairs:

  <!-- bench:killer:start --> … <!-- bench:killer:end -->   one-line killer number (README first screen)
  <!-- bench:table:start -->  … <!-- bench:table:end -->    the full arm table + ablation + latency + re-plan
  <!-- bench:predates:start --> … <!-- bench:predates:end --> the plan-path commits made after the bench run (git log)
  <!-- bench:caveat:start -->  … <!-- bench:caveat:end -->   one-line "predates N changes" caveat under the killer number

bench/predates.json (read by /judge) carries the same commit list.

  python3 scripts/bench_table.py          rewrite README.md and DEMO.md in place
  python3 scripts/bench_table.py --check  exit 1 if either file is stale (no write)
"""
import json
import pathlib
import subprocess
import sys
from datetime import datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent
TARGETS = [ROOT / "README.md", ROOT / "DEMO.md", ROOT / "JUDGE.md"]


def load(name):
    return json.loads((ROOT / "bench" / name).read_text())


def pct(x):
    return f"{x * 100:.1f}%"


def audit_pair(au) -> str:
    """The manual-audit cross-check beside the Qloo-graded headline: the only grade not done by Qloo, and the smaller one."""
    a, b = au["arms"]["A"], au["arms"]["B"]
    return (
        f" Manual audit against public listings (a sample of {a['sampled']} venues per arm; not blind, done by the build agent): "
        f"**{pct(a['rate'])} vs {pct(b['rate'])}** ({a['violations']} of {a['checked']} checkable vs {b['violations']} of {b['checked']}; "
        f"{a['inconclusive']} and {b['inconclusive']} inconclusive, `bench/audit.json`)."
    )


def caveat_md(rows) -> str:
    """One line under the killer number (README, JUDGE): the full commit list lives in DEMO.md's predates block."""
    if not rows:
        return "No plan-path code has changed since this bench run."
    return (
        f"**Caveat: this bench run predates {len(rows)} later changes to the plan path** (listed in [DEMO.md](DEMO.md#bench-reproduce)). "
        "Every bench number on this page, latency included, was measured before them; the bench is re-run on the final deploy before submission."
    )


def killer(r, au) -> str:
    # same grader first (QA round 1): arm A is graded by the address pipeline (Nominatim + /search name match), and so
    # is B-sym (Rekindle's own cards through that pipeline); B by Qloo ID is 0 by construction and is stated second
    a, b, bs = r["arms"]["A"], r["arms"]["B"], r["arms"]["B-sym"]
    return (
        f"**{pct(a['violation_rate'])} vs {pct(bs['violation_rate'])} through the same address pipeline** "
        f"({pct(b['violation_rate'])} when Rekindle's cards are checked by their Qloo ID). Across {r['profiles']} fictional profiles, "
        f"{a['violation']} of {a['outing_venues']} outing venues in plans from the same LLM asked for named places were wrong: "
        f"{a['unverifiable']} unverifiable, {a['closed_at_slot']} closed at the slot, {a['alcohol']} serving alcohol to a patient in recovery. "
        f"Rekindle: {bs['violation']} of {bs['outing_venues']} through the same pipeline ("
        f"{'all ' if bs['unverifiable'] == bs['violation'] else ''}{bs['unverifiable']} unverifiable, i.e. geocode or name-match misses on venues Qloo verified), {b['violation']} of {b['outing_venues']} by Qloo ID (`bench/results.json`, run {r['finished_at'][:16].replace('T', ' ')} UTC)."
        + audit_pair(au)
    )


def receipt(r) -> str:
    """The real-run receipt: wall clock, object counts, model tokens and what is (not) known about provider cost."""
    plans, a_runs = r["plans"], r["arm_a_runs"]
    tok = r.get("tokens")
    if tok and tok.get("llm_calls"):
        part = f" ({tok['unreported']} with no usage reported)" if tok.get("unreported") else ""
        tokens = f"{tok['llm_calls']} model calls, {tok['input']:,} input + {tok['output']:,} output tokens{part}"
    else:
        tokens = "model tokens not recorded by this run (`scripts/bench.py` sums provider-reported usage from the next run on)"
    return (
        f"**Run receipt:** {r['started_at'][:16].replace('T', ' ')} to {r['finished_at'][:16].replace('T', ' ')} UTC, "
        f"**{r['wall_seconds']} s wall clock**; {len(plans)} Rekindle plans + {len(a_runs)} arm-A model plans; "
        f"{sum(x['qloo_calls'] for x in plans)} Qloo calls on the plan path; {r['verify_venue_calls']} `/api/verify-venue` grading calls; "
        f"{len(r['errors'])} errors; {tokens}. "
        f"Plans routed by {', '.join(f'`{m}`' for m in sorted({x['llm'] for x in plans}))}; arm A on `{r['model_arm_a'].split(' ')[0]}`. "
        "Provider cost: no dollar figure is claimed (the provider billing behind these keys is not readable from this repo)."
    )


def table(r, rp, au) -> str:
    arms = r["arms"]
    label = {
        "A": "A · LLM only (same model, asked for named venues)",
        "B": "B · Rekindle",
        "B-sym": "B-sym · Rekindle's cards through arm A's address pipeline",
        "B-": "B− · Rekindle, alcohol screen off",
        "B-4": "B−4 · screen off, 4 bar tags only",
    }
    rows = [
        "| Arm | Outing venues | Wrong (Qloo-graded) | Unverifiable | Closed at slot | Alcohol / in-recovery venues | Unknown hours | Wrong (manual audit) |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for k in ["A", "B", "B-sym", "B-", "B-4"]:
        x = arms[k]
        man = "—"
        if k in au["arms"]:
            m = au["arms"][k]
            man = f"{pct(m['rate'])} ({m['violations']}/{m['checked']}, {m['inconclusive']} inconclusive)"
        rows.append(
            f"| {label[k]} | {x['outing_venues']} | {pct(x['violation_rate'])} ({x['violation']}) | {x['unverifiable']} | {x['closed_at_slot']} | "
            f"{x['alcohol']} / {x['alcohol_denominator']} | {x['unknown_hours']} | {man} |"
        )
    ab = r["ablation_in_recovery"]
    abl = [
        "",
        f"**Ablation** ({ab['B']['profiles']} in-recovery profiles): places Qloo returned that carry an alcohol tag, and how many reached the final plan.",
        "",
        "| Arm | Places Qloo returned | Alcohol-flagged | Flagged places on the plan |",
        "|---|---|---|---|",
    ]
    for k in ["B", "B-", "B-4"]:
        x = ab[k]
        abl.append(f"| {label[k]} | {x['pool_candidates']} | {x['pool_alcohol']} ({pct(x['pool_alcohol_rate'])}) | {x['plan_alcohol_leak']} / {x['outing_cards']} outings |")
    lat = r["latency"]
    lt = [
        "",
        "**Latency** (hosted app, measured by the bench client from request to stored plan):",
        "",
        "| Arm | Plans | p50 | p95 | Qloo calls per plan (mean) |",
        "|---|---|---|---|---|",
    ]
    for k in ["B", "B-", "B-4"]:
        x = lat[k]
        lt.append(f"| {label[k]} | {x['plans']} | {x['client_p50_s']} s | {x['client_p95_s']} s | {x['qloo_calls_mean']} |")
    lt.append(f"| {label['A']} (one model call, no Qloo) | {lat['A']['plans']} | {lat['A']['llm_p50_s']} s | {lat['A']['llm_p95_s']} s | 0 |")
    rpl = [
        "",
        f"**Re-plan responsiveness: {rp['result']}** (`bench/replan.json`). {rp['definition']}",
        f"Excluded (week 1 too thin to rate): {', '.join(e['profile'] if isinstance(e, dict) else str(e) for e in rp['excluded'])}. "
        f"Low-rated entities back in week 2: {rp['low_rated_reappearing']}. New week-2 cards whose top input is a rekindled rating: "
        f"{rp['attributed_new_cards_total']} of {rp['new_cards_total']}; median margin over the best original love {rp['ember_margin_median_of_profiles']}.",
        "",
        f"**Manual audit** (`bench/audit.json`): {au['auditor']}.",
    ]
    defs = r["definitions"]
    head = [
        f"_Generated by `python3 scripts/bench_table.py` from `bench/results.json` ({r['generated_by']}, {r['profiles']} profiles, "
        f"{r['in_recovery_profiles']} in recovery, against {r['base']}, finished {r['finished_at']})._",
        "",
        receipt(r),
        "",
        f"**Wrong** = {defs['killer_number']}. **Unverifiable**: {defs['unverifiable']}.",
        "",
    ]
    return "\n".join(head + rows + abl + lt + rpl)


# the code that decides what a plan contains; a commit touching any of these after the bench run is listed as a caveat
PLAN_PATH = ["lib/verify.ts", "lib/plan.ts", "lib/replan.ts", "lib/agent.ts", "lib/tags.ts", "lib/gate.ts"]
# commits on those files that change no plan behaviour (comments, trace-only fields); everything else is listed
NO_BEHAVIOUR = {"f461510", "1e402e8"}  # 1e402e8: inputTokens on the llm trace event


def predates(r) -> list:
    """Commits on the plan path made after the bench finished (git log; empty outside a git checkout)."""
    try:
        out = subprocess.run(["git", "log", f"--since={r['finished_at']}", "--format=%h%x09%cI%x09%s", "--", *PLAN_PATH],
                             cwd=ROOT, capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return []
    finished = datetime.fromisoformat(r["finished_at"])
    rows = []
    for line in out.splitlines():
        sha, when, subject = line.split("\t", 2)
        if sha[:7] in NO_BEHAVIOUR or datetime.fromisoformat(when) <= finished:
            continue
        short = subject if len(subject) <= 140 else subject[:140].rsplit(" ", 1)[0] + " …"
        rows.append({"commit": sha[:7], "date": when[:10], "subject": short})
    return list(reversed(rows))  # oldest first


def predates_md(rows) -> str:
    if not rows:
        return "No plan-path code has changed since this bench run."
    head = [f"**This bench run predates {len(rows)} later changes to the plan path** (`git log` after `finished_at`, generated by `scripts/bench_table.py`). The numbers above were measured before them; the bench is re-run on the final deploy before submission.", ""]
    return "\n".join(head + [f"- `{x['commit']}` {x['subject']}" for x in rows])


def replace(doc: str, name: str, body: str) -> str:
    s, e = f"<!-- bench:{name}:start -->", f"<!-- bench:{name}:end -->"
    if s not in doc:
        return doc
    return doc[: doc.index(s) + len(s)] + "\n" + body + "\n" + doc[doc.index(e):]


def main() -> int:
    r, rp, au = load("results.json"), load("replan.json"), load("audit.json")
    rows = predates(r)
    stale = []
    pj = ROOT / "bench" / "predates.json"
    pbody = json.dumps({"generated_by": "scripts/bench_table.py", "bench_finished_at": r["finished_at"], "plan_path": PLAN_PATH, "commits": rows}, indent=1, ensure_ascii=False) + "\n"
    if not pj.exists() or pj.read_text() != pbody:
        stale.append("bench/predates.json")
        if "--check" not in sys.argv:
            pj.write_text(pbody)
    for p in TARGETS:
        if not p.exists():
            continue
        doc = p.read_text()
        new = replace(replace(replace(replace(doc, "killer", killer(r, au)), "table", table(r, rp, au)), "predates", predates_md(rows)), "caveat", caveat_md(rows))
        if new != doc:
            stale.append(p.name)
            if "--check" not in sys.argv:
                p.write_text(new)
    if "--check" in sys.argv:
        if stale:
            print("stale bench numbers in: " + ", ".join(stale) + " (run python3 scripts/bench_table.py)", file=sys.stderr)
            return 1
        print("bench numbers in README.md / DEMO.md / JUDGE.md match bench/*.json")
        return 0
    print("updated: " + (", ".join(stale) or "nothing"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
