import subprocess
from types import SimpleNamespace

import pytest
from conftest import run_script


def fake_git(monkeypatch, rc, out="", err=""):
    calls = []

    def run(cmd, **kw):
        calls.append(cmd)
        return SimpleNamespace(returncode=rc, stdout=out, stderr=err)

    monkeypatch.setattr(subprocess, "run", run)
    return calls


def test_clean_tree_passes(monkeypatch, capsys):
    calls = fake_git(monkeypatch, 1)
    assert run_script("kitchen_check", [], monkeypatch) is None
    assert "no private planning files named in tracked files" in capsys.readouterr().out
    assert calls[0][:3] == ["git", "grep", "-nE"]
    assert ":!scripts/kitchen_check.py" in calls[0]


def test_hits_fail_with_count(monkeypatch, capsys):
    fake_git(monkeypatch, 0, "a.md:1:see sp" "ecs/x\nb.ts:2:build-" "plan\n")
    assert run_script("kitchen_check", [], monkeypatch) == 1
    cap = capsys.readouterr()
    assert "a.md:1:see sp" "ecs/x" in cap.out
    assert "2 line(s) name private planning files" in cap.err


def test_git_error_exits_2(monkeypatch, capsys):
    fake_git(monkeypatch, 128, err="fatal: not a git repository")
    assert run_script("kitchen_check", [], monkeypatch) == 2
    assert "not a git repository" in capsys.readouterr().err


@pytest.mark.parametrize(
    "text,hit",
    [
        ("see sp" "ecs/foo", True), ("the build-" "plan", True), ("PRODU" "CT.md", True), ("_ide" "as/x", True),
        ("lib/archi" "tecture.md", True), ("ARCHITECTURE.md", False), ("MY_ARCHITECTURE.md", False), ("plain text", False),
    ],
)
def test_pattern_matches_private_names(monkeypatch, text, hit):
    import re
    captured = {}

    def run(cmd, **kw):
        captured["pattern"] = cmd[3]
        return SimpleNamespace(returncode=1, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", run)
    run_script("kitchen_check", [], monkeypatch)
    assert bool(re.search(captured["pattern"], text, re.M)) is hit
