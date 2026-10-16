#!/usr/bin/env python3
"""Write the bench and rigor numbers into the story page (public/about.html) and the pitch deck (public/pitch.html)
from the committed files — never by hand — and check that every number either page shows is backed by a file.

Sources: bench/audit.json, bench/results.json, bench/replan.json, bench/predates.json (the bench), docs/rigor.json
(scripts/rigor.py: tests, property cases). The pages mark each generated value:

  <span data-n="hand.A.wrong">7</span>       text replaced by the value of that key
  <i data-w="abl.B-4" style="--w:75.0%">     a bar's width, from the same numbers
  <span data-boxes="A">…</span>              the hand check's random 20 venues as boxes: struck = wrong, dashed = inconclusive
  <span class="ver">v0.2.1</span>            the release tag (git describe --tags), when tags are available (CI's shallow
                                             checkout has none, so there the stamp is not checked)

Evidence check: every number in a page's visible text (alt, aria-label and title included) must appear in README.md,
DEMO.md, JUDGE.md, DX-REPORT.md, ARCHITECTURE.md, bench/*.json, docs/rigor.json or public/site/maya-week.json (the
recorded week both pages recreate). An invented number fails the check.

  python3 scripts/site.py          rewrite both pages in place
  python3 scripts/site.py --check  exit 1 if a page is stale or shows a number no file backs (no write)
"""
import html
import json
import pathlib
import re
import subprocess
import sys
from datetime import datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGES = [ROOT / "public" / "about.html", ROOT / "public" / "pitch.html"]
EVIDENCE = ["README.md", "DEMO.md", "JUDGE.md", "DX-REPORT.md", "ARCHITECTURE.md", "docs/rigor.json", "public/site/maya-week.json"]
NUM = re.compile(r"(?<![\w.])\d+(?:[.,:]\d+)*(?!\w)")


def load(rel):
    return json.loads((ROOT / rel).read_text())


def pct(x):
    return f"{x * 100:.1f}%"


def facts():
    au, res, rp, pre, rig = (load(f) for f in ("bench/audit.json", "bench/results.json", "bench/replan.json",
                                               "bench/predates.json", "docs/rigor.json"))
    if pre["bench_finished_at"] != res["finished_at"]:
        sys.exit("site: bench/predates.json is not for bench/results.json; run python3 scripts/bench_table.py first")
    f = {}
    for arm in ("A", "B"):
        a = au["arms"][arm]
        f.update({f"hand.{arm}.wrong": a["violations"], f"hand.{arm}.checked": a["checked"],
                  f"hand.{arm}.inconclusive": a["inconclusive"], f"hand.{arm}.sampled": a["sampled"],
                  f"hand.{arm}.rate": pct(a["rate"])})
    ab = res["ablation_in_recovery"]
    for arm in ("B", "B-", "B-4"):
        f[f"abl.{arm}.leak"], f[f"abl.{arm}.cards"] = ab[arm]["plan_alcohol_leak"], ab[arm]["outing_cards"]
        f[f"abl.{arm}.pool"], f[f"abl.{arm}.flagged"] = ab[arm]["pool_candidates"], ab[arm]["pool_alcohol"]
    f["abl.profiles"] = ab["B"]["profiles"]
    f["replan.passed"], f["replan.N"], f["replan.low_back"] = rp["passed"], rp["N"], rp["low_rated_reappearing"]
    # a2a r11: the headline counts a pass only at the margin the product draws an ember thread for (replan_check.py --rescore)
    f["replan.passed_thread"] = rp["passed_at_thread_margin"]
    f["replan.excluded"] = len(rp["excluded"])   # profiles whose week 1 was too thin to rate (README, Limitations 2)
    lat = res["latency"]["B"]
    f["lat.p50"], f["lat.p95"], f["lat.calls"] = f"{lat['client_p50_s']:.2f} s", f"{lat['client_p95_s']:.2f} s", lat["qloo_calls_mean"]
    f["bench.profiles"] = len(res["profiles"]) if isinstance(res["profiles"], list) else res["profiles"]
    when = datetime.fromisoformat(res["finished_at"])
    f["bench.day"] = f"{when.day} {when:%b %Y}"
    f["bench.utc"] = f"{when:%Y-%m-%d %H:%M} UTC"
    n = len(pre["commits"]) if isinstance(pre["commits"], list) else pre["commits"]
    f["bench.predates"] = n
    # the fact, never a promise (the images' rule since QA round 6); after the D20 re-run n is 0
    f["bench.caveat"] = (f"The bench run of {f['bench.day']} predates {n} later plan-path change{'' if n == 1 else 's'} (listed in DEMO.md)."
                         if n else f"Bench run of {f['bench.day']}; no plan-path code has changed since.")
    f["rigor.tests"], f["rigor.files"], f["rigor.defect"] = rig["tests"], rig["files"], rig["defect_named"]
    f["rigor.cases"], f["rigor.properties"] = f"{rig['property_cases']:,}", rig["properties"]
    f["rigor.runs"] = f"{rig['runs_per_property']:,}"
    return {k: str(v) for k, v in f.items()}, au


def latest_tag():
    r = subprocess.run(["git", "describe", "--tags", "--abbrev=0"], cwd=ROOT, capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None


def boxes(arm):
    a = arm
    ok = a["checked"] - a["violations"]
    return ('<i class="bx x"></i>' * a["violations"]) + ('<i class="bx"></i>' * ok) + ('<i class="bx q"></i>' * a["inconclusive"])


def render(text, f, au, tag=None):
    def n(m):
        key = m.group("key")
        if key not in f:
            sys.exit(f"site: unknown data-n key {key!r}")
        return m.group("open") + html.escape(f[key], quote=False) + m.group("close")
    text = re.sub(r'(?P<open><(?P<tag>[a-z0-9]+)\b[^>]*\bdata-n="(?P<key>[^"]+)"[^>]*>)(?P<body>[^<]*)(?P<close></(?P=tag)>)', n, text)

    def w(m):
        key = m.group("key")
        leak, cards = int(f[f"{key}.leak"]), int(f[f"{key}.cards"])
        return re.sub(r'style="--w:[^"]*"', f'style="--w:{100 * leak / cards:.1f}%"', m.group(0))
    text = re.sub(r'<[a-z]+\b[^>]*\bdata-w="(?P<key>[^"]+)"[^>]*>', w, text)

    def b(m):
        a = au["arms"][m.group("arm")]
        label = (f'{a["sampled"]} venues sampled: {a["violations"]} wrong, {a["checked"] - a["violations"]} right, '
                 f'{a["inconclusive"]} inconclusive')
        op = re.sub(r'aria-label="[^"]*"', f'aria-label="{label}"', m.group("open"))
        return op + boxes(a) + m.group("close")
    text = re.sub(r'(?P<open><span\b[^>]*\bdata-boxes="(?P<arm>[AB])"[^>]*>)(?P<body>.*?)(?P<close></span>)', b, text, flags=re.S)
    if tag:
        text = re.sub(r'(<span class="ver">)v[0-9][^<]*(</span>)', lambda m: m.group(1) + tag + m.group(2), text)
    return text


def visible_numbers(page):
    """numbers a reader can see: text nodes plus alt / aria-label / title values; scripts, styles and comments out"""
    t = re.sub(r"(?is)<(script|style)\b.*?</\1>", " ", page)
    t = re.sub(r"(?s)<!--.*?-->", " ", t)
    attrs = " ".join(m.group(2) for m in re.finditer(r'\b(alt|aria-label|title)="([^"]*)"', t))
    t = re.sub(r"<[^>]+>", " ", t) + " " + attrs
    return set(NUM.findall(html.unescape(t)))


def evidence_numbers():
    corpus = " ".join((ROOT / p).read_text(errors="replace") for p in EVIDENCE)
    corpus += " ".join(p.read_text(errors="replace") for p in sorted((ROOT / "bench").glob("*.json")))
    return set(NUM.findall(corpus))


def main():
    check = "--check" in sys.argv
    f, au = facts()
    tag = latest_tag()
    ev = evidence_numbers()
    stale, unbacked, total = [], [], 0
    for page in PAGES:
        if not page.exists():
            continue
        cur = page.read_text()
        new = render(cur, f, au, tag)
        if new != cur:
            if check:
                stale.append(page.relative_to(ROOT))
            else:
                page.write_text(new)
        nums = visible_numbers(new)
        total += len(nums)
        unbacked += [f"{page.relative_to(ROOT)}: {x}" for x in sorted(nums - ev)]
    for s in stale:
        print(f"site: {s} is stale; run python3 scripts/site.py")
    for u in unbacked:
        print(f"site: no evidence file shows the number {u}")
    if stale or unbacked:
        sys.exit(1)
    print(f"site: {total} distinct numbers on {len([p for p in PAGES if p.exists()])} pages, each backed by a committed file"
          + ("" if check else "; pages written"))


if __name__ == "__main__":
    main()
