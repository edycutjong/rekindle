#!/usr/bin/env python3
"""Fails when a tracked Markdown file points at a local file (image src= or ![](...) or [](...)) that is not
committed. A local .git/info/exclude or .gitignore rule can hide a file the README shows; on GitHub it then
renders as a broken image. Run by `npm run check` (kitchen:check)."""
import re, subprocess, sys
from pathlib import PurePosixPath

tracked = set(subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout.splitlines())
md_files = [f for f in tracked if f.lower().endswith(".md") and not f.startswith("node_modules/")]
PATTERNS = [re.compile(r'''src=["']([^"']+)["']'''), re.compile(r'!?\[[^\]]*\]\(([^)\s]+)')]
missing = []
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
                    elif part != ".":
                        parts.append(part)
                path = "/".join(parts)
                if path in tracked or any(t.startswith(path.rstrip("/") + "/") for t in tracked):
                    continue
                missing.append(f"{md}:{n}: {ref} is not a tracked file")
if missing:
    print("\n".join(missing))
    print(f"md_assets_check: {len(missing)} local link(s) in Markdown point at untracked files", file=sys.stderr)
    sys.exit(1)
print(f"md_assets_check: every local link in {len(md_files)} tracked Markdown files resolves to a tracked file")
