import json
import subprocess
from types import SimpleNamespace

import pytest

import rigor

TESTS = [
    {"name": "plain test", "file": "a.test.ts"},
    {"name": "QA round 3: thing", "file": "a.test.ts"},
    {"name": "P8 probe", "file": "b.test.ts"},
    {"name": "COACH-ALC never mentions drinking", "file": "b.test.ts"},
    {"name": "P7 is below the defect floor", "file": "b.test.ts"},
]
README = (
    "badge tests-1_passing\n**1** (Vitest, 1 files)\n**1 tests** (Vitest, 1 files)\n**9** (1 properties × 5, fixed seeds)\n"
    "Tests named for the defect they pin | 1 row\n10.0% lines · 20.0% branches\n"
)
JUDGE = "1 Vitest tests, 1 files and 7 generated cases (1 properties × 3, fixed seeds)\n"


@pytest.fixture
def repo(tmp_path, monkeypatch):
    (tmp_path / "docs").mkdir()
    (tmp_path / "tests").mkdir()
    (tmp_path / "coverage").mkdir()
    (tmp_path / "README.md").write_text(README)
    (tmp_path / "JUDGE.md").write_text(JUDGE)
    (tmp_path / "tests" / "verify.property.test.ts").write_text("export const RUNS = 1_000;\nfc.assert(x, { numRuns: RUNS });\nfc.assert(y, { numRuns: RUNS });\nnumRuns: 5\n")
    for name, val in (("ROOT", tmp_path), ("OUT", tmp_path / "docs" / "rigor.json"), ("PROPERTY_FILE", tmp_path / "tests" / "verify.property.test.ts"),
                      ("COVERAGE", tmp_path / "coverage" / "coverage-summary.json")):
        monkeypatch.setattr(rigor, name, val)
    state = SimpleNamespace(tests=list(TESTS), calls=[], root=tmp_path)

    def run(cmd, **kw):
        state.calls.append((cmd, kw))
        out = next(a.split("=", 1)[1] for a in cmd if a.startswith("--json="))
        open(out, "w").write(json.dumps(state.tests))
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(rigor.subprocess, "run", run)
    return state


def set_cov(root, lines=91.27, branches=82.99):
    (root / "coverage" / "coverage-summary.json").write_text(json.dumps({"total": {"lines": {"pct": lines}, "branches": {"pct": branches}}}))


def test_measure_counts(repo):
    m = rigor.measure()
    assert m == {"generated_by": "scripts/rigor.py", "tests": 5, "files": 2, "defect_named": 3, "properties": 2, "runs_per_property": 1000, "property_cases": 2000}
    cmd, kw = repo.calls[0]
    assert cmd[:4] == ["npx", "vitest", "list", "--no-staticParse"] and kw["cwd"] == repo.root and kw["check"] is True


def test_measure_rejects_template_names(repo):
    repo.tests = [{"name": "per backend ${name}", "file": "a"}]
    with pytest.raises(SystemExit, match=r"1 test name\(s\) still hold a template"):
        rigor.measure()


def test_measure_propagates_vitest_failure(repo, monkeypatch):
    def boom(cmd, **kw):
        raise subprocess.CalledProcessError(1, cmd)

    monkeypatch.setattr(rigor.subprocess, "run", boom)
    with pytest.raises(subprocess.CalledProcessError):
        rigor.measure()


def test_coverage_reader(repo):
    assert rigor.coverage() is None
    set_cov(repo.root)
    assert rigor.coverage() == {"lines": 91.27, "branches": 82.99}


def test_floor1():
    assert [rigor.floor1(x) for x in (91.27, 82.99, 100.0, 0.05)] == ["91.2", "82.9", "100.0", "0.0"]


def test_rules_are_seven_patterns_with_counts():
    m = {"tests": 5, "files": 2, "property_cases": 2000, "properties": 2, "runs_per_property": 1000, "defect_named": 3}
    r = rigor.rules(m)
    assert len(r) == 7
    assert ("README.md", r"tests-\d+_passing", "tests-5_passing") in r
    assert ("JUDGE.md", r"[\d,]+ generated cases \(\d+ properties × [\d,]+, fixed seeds\)", "2,000 generated cases (2 properties × 1,000, fixed seeds)") in r
    assert ("README.md", r"Tests named for the defect they pin \| \d+ ", "Tests named for the defect they pin | 3 ") in r


def test_main_writes_everything_then_check_passes(repo, monkeypatch, capsys):
    set_cov(repo.root)
    monkeypatch.setattr("sys.argv", ["rigor.py"])
    assert rigor.main() == 0
    out = capsys.readouterr().out
    assert out == "updated: docs/rigor.json, README.md, JUDGE.md (5 tests in 2 files, 2,000 property cases, 3 defect-named, coverage 91.27% lines / 82.99% branches)\n"
    assert json.loads((repo.root / "docs" / "rigor.json").read_text())["tests"] == 5
    readme = (repo.root / "README.md").read_text()
    for frag in ("tests-5_passing", "**5** (Vitest, 2 files)", "**5 tests** (Vitest, 2 files)", "**2,000** (2 properties × 1,000, fixed seeds)", "defect they pin | 3 row", "91.2% lines · 82.9% branches"):
        assert frag in readme
    assert (repo.root / "JUDGE.md").read_text() == "5 Vitest tests, 2 files and 2,000 generated cases (2 properties × 1,000, fixed seeds)\n"

    monkeypatch.setattr("sys.argv", ["rigor.py", "--check"])
    assert rigor.main() == 0
    assert "match the suite (5 tests in 2 files" in capsys.readouterr().out
    monkeypatch.setattr("sys.argv", ["rigor.py"])
    assert rigor.main() == 0
    assert capsys.readouterr().out.startswith("updated: nothing")


def test_main_without_coverage_file(repo, monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["rigor.py"])
    assert rigor.main() == 0
    cap = capsys.readouterr()
    assert "coverage/coverage-summary.json not found" in cap.err and "coverage" not in cap.out
    assert "10.0% lines · 20.0% branches" in (repo.root / "README.md").read_text()  # left untouched


def test_check_reports_stale_without_writing(repo, monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["rigor.py", "--check"])
    assert rigor.main() == 1
    err = capsys.readouterr().err
    assert "stale rigor numbers in: docs/rigor.json, README.md, JUDGE.md (measured 5 tests in 2 files" in err
    assert not (repo.root / "docs" / "rigor.json").exists() and (repo.root / "README.md").read_text() == README


def test_check_stale_json_only_when_body_differs(repo, monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["rigor.py"])
    rigor.main()
    (repo.root / "docs" / "rigor.json").write_text("{}")
    monkeypatch.setattr("sys.argv", ["rigor.py", "--check"])
    assert rigor.main() == 1
    assert "stale rigor numbers in: docs/rigor.json (" in capsys.readouterr().err


@pytest.mark.parametrize("lines,branches,ok", [(91.27 + 0.3, 82.99, True), (91.27, 82.99 - 0.6, False), (91.27 - 0.6, 82.99, False)])
def test_check_coverage_tolerance(repo, monkeypatch, capsys, lines, branches, ok):
    set_cov(repo.root)
    monkeypatch.setattr("sys.argv", ["rigor.py"])
    rigor.main()
    capsys.readouterr()
    set_cov(repo.root, lines, branches)
    monkeypatch.setattr("sys.argv", ["rigor.py", "--check"])
    assert (rigor.main() == 0) is ok
    if not ok:
        assert "README.md: coverage says 91.2% lines · 82.9% branches, measured" in capsys.readouterr().err


def test_problem_when_a_pattern_no_longer_matches(repo, monkeypatch, capsys):
    (repo.root / "JUDGE.md").write_text("reworded\n")
    set_cov(repo.root)
    monkeypatch.setattr("sys.argv", ["rigor.py"])
    assert rigor.main() == 1
    err = capsys.readouterr().err
    assert err.count("JUDGE.md: no line matches") == 2


def test_problem_when_readme_has_no_coverage_line(repo, monkeypatch, capsys):
    (repo.root / "README.md").write_text(README.replace("10.0% lines · 20.0% branches", "no numbers"))
    set_cov(repo.root)
    monkeypatch.setattr("sys.argv", ["rigor.py"])
    assert rigor.main() == 1
    assert "README.md: no coverage line matches" in capsys.readouterr().err
