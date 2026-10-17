#!/usr/bin/env python3
"""Fails when a tracked Markdown file points at a local file (image src= or ![](...) or [](...)) that is not
committed. A local .git/info/exclude or .gitignore rule can hide a file the README shows; on GitHub it then
renders as a broken image. Also fails when a `tests/<file>.ts:<line>` reference (README "Attacks defeated") no longer
lands on the test it cites (a2a r09: two rows had drifted onto an assertion and a closing brace; a2a r10: landing on
*an* it() was not enough, so every reference is a link whose title is the cited test's title, or its start, and the
line must open exactly that test). Run by `npm run check` (kitchen:check)."""
import re, subprocess, sys
from pathlib import PurePosixPath

tracked = set(subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout.splitlines())
md_files = [f for f in tracked if f.lower().endswith(".md") and not f.startswith("node_modules/")]
PATTERNS = [re.compile(r'''src=["']([^"']+)["']'''), re.compile(r'!?\[[^\]]*\]\(([^)\s]+)')]
missing = []
TEST_REF = re.compile(r"(tests/[\w.-]+\.ts):(\d+)")
# [`tests/x.test.ts:N`](tests/x.test.ts#LN "<the test's title, or its start>")
TITLED = re.compile(r'\[`(tests/[\w.-]+\.ts):(\d+)`\]\((tests/[\w.-]+\.ts)#L(\d+) "([^"]+)"\)')
TEST_TITLE = re.compile(r"""\s*(?:it|test)(?:\.\w+)?\(\s*(["'`])(.*?)\1""")
for md in md_files:
    for n, line in enumerate(open(md, encoding="utf-8", errors="replace"), 1):
        titled = TITLED.findall(line)
        if len(titled) != len(TEST_REF.findall(line)):
            missing.append(f"{md}:{n}: cite a test as [`tests/<file>.ts:N`](tests/<file>.ts#LN \"<its title>\")")
        for f, ln, f2, ln2, title in titled:
            src = open(f, encoding="utf-8").read().splitlines() if f in tracked else []
            at = src[int(ln) - 1] if 0 < int(ln) <= len(src) else ""
            m = TEST_TITLE.match(at)
            if (f, ln) != (f2, ln2):
                missing.append(f"{md}:{n}: {f}:{ln} links to {f2}#L{ln2}")
            elif not m:
                missing.append(f"{md}:{n}: {f}:{ln} is not the start of a test ({at.strip()[:60]!r})")
            elif not m.group(2).replace('"', "'").startswith(title):
                found = [k + 1 for k, l in enumerate(src) if (t := TEST_TITLE.match(l)) and t.group(2).replace('"', "'").startswith(title)]
                missing.append(f"{md}:{n}: {f}:{ln} opens another test ({m.group(2)[:60]!r}); \"{title[:40]}…\" is at {found or 'no line'}")
for md in md_files:
    base = PurePosixPath(md).parent
    for n, line in enumerate(open(md, encoding="utf-8", errors="replace"), 1):
        for pat in PATTERNS:
            for ref in pat.findall(line):
                ref = ref.split("#", 1)[0].split("?", 1)[0]
                if not ref or re.match(r"^[a-z][a-z0-9+.-]*:", ref, re.I) or ref.startswith(("/", "<")):
                    continue  # URLs, mailto:, anchors, site-absolute paths
                p = PurePosixPath(*(base / ref).parts)
                parts = []
                for part in p.parts:
                    if part == "..":
                        parts = parts[:-1]
                    else:  # PurePosixPath never yields "." parts, so no `part != "."` guard is needed
                        parts.append(part)
                path = "/".join(parts)
                if path in tracked or any(t.startswith(path.rstrip("/") + "/") for t in tracked):
                    continue
                missing.append(f"{md}:{n}: {ref} is not a tracked file")
if missing:
    print("\n".join(missing))
    print(f"md_assets_check: {len(missing)} Markdown reference(s) point at an untracked file or off a test", file=sys.stderr)
    sys.exit(1)
print(f"md_assets_check: every local link in {len(md_files)} tracked Markdown files resolves to a tracked file; every tests/*.ts:N opens the test its title names")
