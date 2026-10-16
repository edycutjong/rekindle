#!/usr/bin/env python3
"""Write the bench numbers into README.md, DEMO.md and JUDGE.md from the committed bench files — never by hand.

Sources: bench/results.json (scripts/bench.py), bench/replan.json (scripts/replan_check.py),
bench/audit.json (scripts/manual_audit.py summary). Each target file carries marker pairs:

  <!-- bench:killer:start --> … <!-- bench:killer:end -->   one-line killer number (README first screen)
  <!-- bench:table:start -->  … <!-- bench:table:end -->    the full arm table + ablation + latency + re-plan
  <!-- bench:predates:start --> … <!-- bench:predates:end --> the plan-path commits made after the bench run (git log)
  <!-- bench:caveat:start -->  … <!-- bench:caveat:end -->   one-line "predates N changes" caveat under the killer number
  <!-- bench:ember:start -->   … <!-- bench:ember:end -->     ember-thread counts (bench/ember-live.json ← scripts/ember-margins.ts)

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


def auditor_phrase(au) -> str:
    """Who checked the manual-audit sample, named wherever its number appears (QA on the story page, B21: "checked by
    hand" reads as a person; the auditor was the build agent, Claude). Read from bench/audit.json, so an external audit
    that replaces it changes the wording with the numbers."""
    who = au.get("auditor", "")
    if who.startswith("the build agent (Claude)"):
        return "checked one by one against public listings by our build agent (Claude, an AI; not blind)"
    return f"checked against public listings by {who.split(':')[0]}" if who else "checked against public listings"


def audit_pair(au) -> str:
    """The manual-audit cross-check beside the Qloo-graded headline: the only grade not done by Qloo, and the smaller one."""
    a, b = au["arms"]["A"], au["arms"]["B"]
    return (
        f" Manual audit (a sample of {a['sampled']} venues per arm, {auditor_phrase(au)}): "
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


def plural(n: int, one: str, many: str) -> str:
    """'1 venue', '0 venues', '3 venues' — so a re-run with 0 or 1 never prints 'all 0' or '1 don't'"""
    return f"{n} {one if n == 1 else many}"


def killer(r, au) -> str:
    # a2a r05 (judge lens): the manual audit leads. It is a random sample of the same venues, graded against public
    # listings, and it disagrees with the automated checker: oracle_vs_hand in bench/audit.json shows the checker
    # flagging real, open places (large venues such as parks sit far from a street address) as unverifiable. a2a r11: the
    # full-run checker numbers, with that over-flag stated, moved to DEMO.md (checker_note); this line points there.
    am, bm = au["arms"]["A"], au["arms"]["B"]
    return (
        f"**Asked for named places, the same LLM got {am['violations']} of {plural(am['checked'], 'audited venue', 'audited venues')} wrong "
        f"({pct(am['rate'])}); Rekindle: {bm['violations']} of {bm['checked']}.** "
        f"Wrong means not found ({am['not_found']}), closed at the planned hour ({am['closed_at_slot']}) or serving alcohol to a patient in recovery "
        f"({am['alcohol']}); a random {am['sampled']} per arm, {auditor_phrase(au)}; inconclusive: {am['inconclusive']} of the LLM's "
        f"{am['sampled']} and {bm['inconclusive']} of Rekindle's {bm['sampled']} (`bench/audit.json`). "
        f"The automated checker's count over all {r['profiles']} profiles, and why it over-flags, is in [DEMO.md](DEMO.md#bench-reproduce)."
    )


def checker_note(r, au) -> str:
    """a2a r11 (judge lens): the full-run checker sentence moved from the README's first screen to DEMO.md's table block."""
    a, b, bs = r["arms"]["A"], r["arms"]["B"], r["arms"]["B-sym"]
    ovh = (au.get("oracle_vs_hand") or {}).get("A", {}).get("unverifiable", {})
    fu = sum(ovh.values()) if ovh else 0
    fp = ovh.get("ok", 0) if ovh else 0
    over = (
        f", but it over-flags: in the same random sample, {fp} of the {plural(fu, 'venue', 'venues')} it couldn't match "
        f"{'was' if fp == 1 else 'were'} real and open, because it matches by street address and misses large venues such as parks"
        if fp else ""
    )
    return (
        f"**Automated checker.** On all {r['profiles']} fictional profiles it flags {a['violation']} of the LLM's {plural(a['outing_venues'], 'venue', 'venues')} "
        f"and {bs['violation']} of Rekindle's {b['outing_venues']} ({b['violation']} by Qloo ID){over} "
        f"(`bench/results.json`, run {r['finished_at'][:16].replace('T', ' ')} UTC). This is why the manual audit leads."
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
        "B-": "B− · screen off, 14-tag exclusion kept",
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


def ember_md() -> str:
    """The ember-thread receipt, from bench/ember-live.json (live re-plans + the bench's cards, same margin)."""
    p = ROOT / "bench" / "ember-live.json"
    if not p.exists():
        return "Ember threads: `scripts/ember-margins.ts` has not been run yet."
    e = json.loads(p.read_text())
    b = e.get("bench") or {}
    bench = f" On the bench's {b['cards_with_margin']} new week-2 cards (`{b['source']}`, the same margin), {b['threaded']} clear it." if b else ""
    d = e["distinct"]
    return (
        f"**Ember threads on live re-plans** (`bench/ember-live.json`, `scripts/ember-margins.ts`, {e['generated_at'][:16].replace('T', ' ')} UTC): "
        f"{plural(e['replans'], 're-plan', 're-plans')} with {plural(d['rating_sets'], 'distinct rating set', 'distinct rating sets')} (Qloo returns the same week for the same ratings). "
        f"Of {d['cards']} distinct new week-2 cards that name a rating, a rating outweighed the case's best original love on {d['rating_leads_loves']}; "
        f"{d['threaded']} cleared the {e['threshold']} lead that draws a thread and {d['rating_leads_loves'] - d['threaded']} are shown as ties. "
        f"The previous rule (a lead over the next input of any kind) threaded {d['previous_rule_threaded']} of the same cards.{bench} "
        "The live sample is small; Qloo's attribution, not causation."
    )


def replace(doc: str, name: str, body: str) -> str:
    s, e = f"<!-- bench:{name}:start -->", f"<!-- bench:{name}:end -->"
    if s not in doc:
        return doc
    return doc[: doc.index(s) + len(s)] + "\n" + body + "\n" + doc[doc.index(e):]


def head_sha() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short=7", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def stale_files(r, rp, au, rows, write: bool) -> list:
    stale = []
    pj = ROOT / "bench" / "predates.json"
    pbody = json.dumps({"generated_by": "scripts/bench_table.py", "bench_finished_at": r["finished_at"], "plan_path": PLAN_PATH, "commits": rows}, indent=1, ensure_ascii=False) + "\n"
    if not pj.exists() or pj.read_text() != pbody:
        stale.append("bench/predates.json")
        if write:
            pj.write_text(pbody)
    for p in TARGETS:
        if not p.exists():
            continue
        doc = p.read_text()
        new = replace(replace(replace(replace(replace(doc, "killer", killer(r, au)), "table", checker_note(r, au) + "\n\n" + table(r, rp, au)), "predates", predates_md(rows)), "caveat", caveat_md(rows)), "ember", ember_md())
        if new != doc:
            stale.append(p.name)
            if write:
                p.write_text(new)
    return stale


def devpost_bullets(r, au) -> list[str]:
    """a2a r05: the Devpost copy of "The number" and "Ablation", generated from the same files as the README, so the
    kitchen check (../scripts/devpost_check.py) can fail when the pasted copy drifts after the final bench re-run."""
    a, b, bs = r["arms"]["A"], r["arms"]["B"], r["arms"]["B-sym"]
    am, bm = au["arms"]["A"], au["arms"]["B"]
    ovh = (au.get("oracle_vs_hand") or {}).get("A", {}).get("unverifiable", {})
    fu, fp = sum(ovh.values()), ovh.get("ok", 0)
    over = f", but {fp} of the {plural(fu, 'venue', 'venues')} it couldn't match in the audit sample {'was' if fp == 1 else 'were'} real and open" if fp else ""
    number = (
        f"- **The number:** asked for named places, the same LLM got {am['violations']} of {plural(am['checked'], 'audited venue', 'audited venues')} wrong "
        f"({round((am['rate'] or 0) * 100)}%: {am['not_found']} not found, {am['closed_at_slot']} closed at the planned hour, {am['alcohol']} serving alcohol to a patient in recovery); "
        f"Rekindle got {bm['violations']} of {bm['checked']} (a random {am['sampled']} per arm, {auditor_phrase(au)}; `bench/audit.json`). "
        f"We lead with this manual audit because our automated checker leans on Qloo, which flatters Rekindle, and over-flags the LLM: across all "
        f"{r['profiles']} profiles it flags {a['violation']} of {a['outing_venues']} vs {bs['violation']} of {b['outing_venues']}{over}."
    )
    ab = r["ablation_in_recovery"]
    on, off, four = ab["B"], ab["B-"], ab["B-4"]
    ablation = (
        f"- **Ablation** ({plural(on['profiles'], 'in-recovery profile', 'in-recovery profiles')}): with the screen on, {on['plan_alcohol_leak']} of {on['outing_cards']} outing cards carry an alcohol tag or keyword. "
        f"Screen off, our 14-tag exclusion (sent through Qloo's filter) kept: {off['plan_alcohol_leak']} of {off['outing_cards']}. "
        f"Screen off, only the 4 obvious bar tags excluded: {four['plan_alcohol_leak']} of {four['outing_cards']} (`bench/results.json`, `ablation_in_recovery`)."
    )
    return [number, ablation]


def main() -> int:
    r, rp, au = load("results.json"), load("replan.json"), load("audit.json")
    if "--devpost" in sys.argv:
        print("\n".join(devpost_bullets(r, au)))
        return 0
    rows = predates(r)
    if "--check" not in sys.argv:
        print("updated: " + (", ".join(stale_files(r, rp, au, rows, True)) or "nothing"))
        return 0
    stale = stale_files(r, rp, au, rows, False)
    # A commit cannot contain its own hash: when HEAD itself is a plan-path commit, docs that list everything
    # BEFORE it are current too (the follow-up `npm run docs` commit adds it). Only HEAD gets this grace; any
    # older unlisted plan-path commit still fails.
    if stale and rows and rows[-1]["commit"] == head_sha() and not stale_files(r, rp, au, rows[:-1], False):
        print(f"bench numbers match bench/*.json; HEAD {rows[-1]['commit']} is a plan-path commit not yet listed (run `npm run docs` in a follow-up commit)")
        return 0
    if stale:
        print("stale bench numbers in: " + ", ".join(stale) + " (run python3 scripts/bench_table.py)", file=sys.stderr)
        return 1
    print("bench numbers in README.md / DEMO.md / JUDGE.md match bench/*.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
