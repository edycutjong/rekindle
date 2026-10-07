#!/usr/bin/env python3
"""Fails when a tracked file names a private planning document (the repo is judge-facing: every file a comment or
doc points at must be one a reader can open). Run by `npm run check`; also the pre-publication filename scan."""
import subprocess, sys

PATTERN = (r"specs/|build-plan|complexity\.md|production-plan|seed-data\.md|\bui\.md|\bdesign\.md|(^|[^A-Z_])architecture\.md"
           r"|sponsor-defense|qloo-probes|decision\.md|BUILD_LOG|progress\.md|PRODUCT\.md|_ideas/|_specs/")
EXCLUDE = [":!.gitignore", ":!package-lock.json", ":!scripts/kitchen_check.py"]

r = subprocess.run(["git", "grep", "-nE", PATTERN, "--", "."] + EXCLUDE, capture_output=True, text=True)
if r.returncode == 0:
    print(r.stdout, end="")
    print(f"kitchen_check: {len(r.stdout.splitlines())} line(s) name private planning files", file=sys.stderr)
    sys.exit(1)
if r.returncode not in (0, 1):
    print(r.stderr, file=sys.stderr); sys.exit(2)
print("no private planning files named in tracked files")
