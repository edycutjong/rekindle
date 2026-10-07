#!/usr/bin/env python3
"""Keep the test and coverage numbers in README.md, JUDGE.md and /judge equal to what the suite measures — never by hand.

Measured (no keys, no network):
  tests, files      `vitest list --json` (collects every test without running it; < 1 s)
  property cases    properties in tests/verify.property.test.ts × its RUNS constant
  defect-named      tests whose name cites the defect they pin: a probe (P8+), a bench finding (B5, D9),
                    a QA round, or a COACH-* rule (DEFECT below)
  coverage          coverage/coverage-summary.json from `npm run test:coverage` (lines, branches)

docs/rigor.json carries the exact counts (read by /judge). The prose is rewritten in place by pattern.

  python3 scripts/rigor.py          rewrite docs/rigor.json, README.md, JUDGE.md
  python3 scripts/rigor.py --check  exit 1 if any of them is stale (no write). Coverage is compared with a
                                    0.5-point tolerance (v8 coverage moves slightly across Node majors) and only
                                    when coverage/coverage-summary.json exists (CI Stage 1 runs test:coverage first).
"""
import json
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "rigor.json"
PROPERTY_FILE = ROOT / "tests" / "verify.property.test.ts"
COVERAGE = ROOT / "coverage" / "coverage-summary.json"
DEFECT = r"\bP([89]|[1-9]\d)\b|\bB5\b|\bD9\b|QA round|COACH-[A-Z]+"
TOLERANCE = 0.5


def measure() -> dict:
    with tempfile.TemporaryDirectory() as d:
        out = pathlib.Path(d) / "list.json"
        subprocess.run(["npx", "vitest", "list", f"--json={out}"], cwd=ROOT, check=True, capture_output=True)
        tests = json.loads(out.read_text())
    src = PROPERTY_FILE.read_text()
    runs = int(re.search(r"export const RUNS = ([\d_]+);", src).group(1).replace("_", ""))
    properties = len(re.findall(r"numRuns: RUNS\b", src))
    return {
        "generated_by": "scripts/rigor.py",
        "tests": len(tests),
        "files": len({t["file"] for t in tests}),
        "defect_named": sum(1 for t in tests if re.search(DEFECT, t["name"])),
        "properties": properties,
        "runs_per_property": runs,
        "property_cases": properties * runs,
    }


def coverage():
    if not COVERAGE.exists():
        return None
    total = json.loads(COVERAGE.read_text())["total"]
    return {"lines": total["lines"]["pct"], "branches": total["branches"]["pct"]}


def floor1(x: float) -> str:
    return f"{int(x * 10) / 10:.1f}"


# (file, pattern, replacement) — each pattern must match at least once, or the check fails (a reworded line would
# otherwise escape the gate silently)
def rules(m: dict):
    n, f = m["tests"], m["files"]
    cases, props, runs = f"{m['property_cases']:,}", m["properties"], f"{m['runs_per_property']:,}"
    return [
        ("README.md", r"tests-\d+_passing", f"tests-{n}_passing"),
        ("README.md", r"\*\*\d+\*\* \(Vitest, \d+ files\)", f"**{n}** (Vitest, {f} files)"),
        ("README.md", r"\*\*\d+ tests\*\* \(Vitest, \d+ files\)", f"**{n} tests** (Vitest, {f} files)"),
        ("README.md", r"\*\*[\d,]+\*\* \(\d+ properties × [\d,]+, fixed seeds\)", f"**{cases}** ({props} properties × {runs}, fixed seeds)"),
        ("README.md", r"Tests named for the defect they pin \| \d+ ", f"Tests named for the defect they pin | {m['defect_named']} "),
        ("JUDGE.md", r"\d+ Vitest tests, \d+ files", f"{n} Vitest tests, {f} files"),
        ("JUDGE.md", r"[\d,]+ generated cases \(\d+ properties × [\d,]+, fixed seeds\)", f"{cases} generated cases ({props} properties × {runs}, fixed seeds)"),
    ]


COV_RE = r"([\d.]+)% lines · ([\d.]+)% branches"


def main() -> int:
    check = "--check" in sys.argv
    m = measure()
    cov = coverage()
    stale, problems = [], []
    body = json.dumps(m, indent=1) + "\n"
    if not OUT.exists() or OUT.read_text() != body:
        stale.append(str(OUT.relative_to(ROOT)))
        if not check:
            OUT.write_text(body)
    docs = {name: (ROOT / name).read_text() for name in ("README.md", "JUDGE.md")}
    new = dict(docs)
    for name, pat, rep in rules(m):
        if not re.search(pat, new[name]):
            problems.append(f"{name}: no line matches /{pat}/ (reworded? update scripts/rigor.py)")
            continue
        new[name] = re.sub(pat, rep, new[name])
    hit = re.search(COV_RE, new["README.md"])
    if not hit:
        problems.append(f"README.md: no coverage line matches /{COV_RE}/")
    elif cov:
        lines, branches = float(hit.group(1)), float(hit.group(2))
        if check:
            if abs(lines - cov["lines"]) > TOLERANCE or abs(branches - cov["branches"]) > TOLERANCE:
                problems.append(f"README.md: coverage says {lines}% lines · {branches}% branches, measured {cov['lines']}% · {cov['branches']}% (run npm run test:coverage && python3 scripts/rigor.py)")
        else:
            new["README.md"] = re.sub(COV_RE, f"{floor1(cov['lines'])}% lines · {floor1(cov['branches'])}% branches", new["README.md"])
    else:
        print("rigor: coverage/coverage-summary.json not found; coverage line not checked (run npm run test:coverage)", file=sys.stderr)
    for name in docs:
        if new[name] != docs[name]:
            stale.append(name)
            if not check:
                (ROOT / name).write_text(new[name])
    summary = f"{m['tests']} tests in {m['files']} files, {m['property_cases']:,} property cases, {m['defect_named']} defect-named"
    if cov:
        summary += f", coverage {cov['lines']}% lines / {cov['branches']}% branches"
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    if check:
        if stale:
            print(f"stale rigor numbers in: {', '.join(stale)} (measured {summary}; run python3 scripts/rigor.py)", file=sys.stderr)
            return 1
        print(f"rigor numbers in README.md / JUDGE.md / docs/rigor.json match the suite ({summary})")
        return 0
    print(f"updated: {', '.join(stale) or 'nothing'} ({summary})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
