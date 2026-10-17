import copy
import json
import subprocess
from types import SimpleNamespace

import pytest

import bench_table as bt

ARM = {"outing_venues": 50, "violation": 10, "violation_rate": 0.2, "unverifiable": 6, "closed_at_slot": 3, "alcohol": 1, "alcohol_denominator": 25, "unknown_hours": 4}


def arm(**kw):
    return {**ARM, **kw}


def results():
    return {
        "generated_by": "scripts/bench.py", "profiles": 20, "in_recovery_profiles": 10, "base": "https://app.example",
        "started_at": "2026-10-16T12:00:00+00:00", "finished_at": "2026-10-16T12:34:56+00:00", "wall_seconds": 1234.5,
        "verify_venue_calls": 400, "errors": [{"profile": "x"}], "model_arm_a": "qwen3.8-flash (enable_thinking=false)",
        "tokens": {"llm_calls": 10, "input": 12345, "output": 6789, "unreported": 2},
        "plans": [{"qloo_calls": 5, "llm": "qwen:x"}, {"qloo_calls": 7, "llm": "deterministic"}, {"qloo_calls": 1, "llm": "qwen:x"}],
        "arm_a_runs": [{}, {}],
        "arms": {"A": arm(violation=30, violation_rate=0.6, outing_venues=60), "B": arm(violation=2, outing_venues=70), "B-sym": arm(violation=12),
                 "B-": arm(), "B-4": arm()},
        "ablation_in_recovery": {k: {"profiles": 10, "pool_candidates": 200, "pool_alcohol": 20, "pool_alcohol_rate": 0.1, "plan_alcohol_leak": n, "outing_cards": 40}
                                 for k, n in (("B", 0), ("B-", 3), ("B-4", 7))},
        "latency": {**{k: {"plans": 10, "client_p50_s": 20.5, "client_p95_s": 31.2, "qloo_calls_mean": 6.5} for k in ("B", "B-", "B-4")},
                    "A": {"plans": 20, "llm_p50_s": 3.1, "llm_p95_s": 5.5}},
        "definitions": {"killer_number": "KILLER-DEF", "unverifiable": "UNVERIFIABLE-DEF"},
    }


def replan():
    return {"result": "9/10", "definition": "DEF.", "excluded": [{"profile": "cal"}, "ruby"], "low_rated_reappearing": 0,
            "attributed_new_cards_total": 12, "new_cards_total": 30, "ember_margin_median_of_profiles": 0.05, "thread_margin": 0.02,
            "threaded_new_cards_total": 8, "passed_at_thread_margin": 7, "N": 10}


def audit():
    side = lambda v: {"sampled": 20, "checked": 18, "inconclusive": 2, "violations": v, "rate": v / 18, "not_found": 3, "closed_at_slot": 2, "alcohol": 1}
    return {"auditor": "the build agent (Claude): by hand", "arms": {"A": side(9), "B": side(1)},
            "oracle_vs_hand": {"A": {"unverifiable": {"ok": 2, "wrong": 3}}}}


@pytest.fixture
def root(tmp_path, monkeypatch):
    (tmp_path / "bench").mkdir()
    for name, d in (("results.json", results()), ("replan.json", replan()), ("audit.json", audit())):
        (tmp_path / "bench" / name).write_text(json.dumps(d))
    monkeypatch.setattr(bt, "ROOT", tmp_path)
    monkeypatch.setattr(bt, "TARGETS", [tmp_path / "README.md", tmp_path / "DEMO.md", tmp_path / "JUDGE.md"])
    return tmp_path


def git(monkeypatch, stdout="", exc=None, head="abc1234"):
    def run(cmd, **kw):
        if exc:
            raise exc
        return SimpleNamespace(stdout=head + "\n" if cmd[1] == "rev-parse" else stdout)

    monkeypatch.setattr(bt.subprocess, "run", run)


def log(*entries):
    return "".join("\t".join(e) + "\n" for e in entries)


# ---------------------------------------------------------------- small formatters

def test_pct_plural():
    assert bt.pct(0.1234) == "12.3%"
    assert [bt.plural(n, "venue", "venues") for n in (0, 1, 3)] == ["0 venues", "1 venue", "3 venues"]


@pytest.mark.parametrize(
    "au,expected",
    [
        ({"auditor": "the build agent (Claude): prompt"}, "checked one by one against public listings by our build agent (Claude, an AI; not blind)"),
        ({"auditor": "Dr Jane: contractor"}, "checked against public listings by Dr Jane"),
        ({}, "checked against public listings"),
    ],
)
def test_auditor_phrase(au, expected):
    assert bt.auditor_phrase(au) == expected


def test_audit_pair():
    s = bt.audit_pair(audit())
    assert "a sample of 20 venues per arm" in s and "**50.0% vs 5.6%** (9 of 18 checkable vs 1 of 18; 2 and 2 inconclusive" in s


def test_caveat_md():
    assert bt.caveat_md([]) == "No plan-path code has changed since this bench run."
    assert "predates 2 later changes" in bt.caveat_md([1, 2])


def test_killer_line():
    k = bt.killer(results(), audit())
    assert "the same LLM got 9 of 18 audited venues wrong (50.0%); Rekindle: 1 of 18" in k
    assert "not found (3), closed at the planned hour (2) or serving alcohol to a patient in recovery (1)" in k
    assert "over all 20 profiles" in k


def test_killer_singular_checked():
    au = audit()
    au["arms"]["A"]["checked"] = 1
    assert "of 1 audited venue wrong" in bt.killer(results(), au)


@pytest.mark.parametrize(
    "ovh,expect_over,verb",
    [
        ({"ok": 2, "wrong": 3}, True, "were"),
        ({"ok": 1}, True, "was"),
        ({"wrong": 3}, False, None),
        ({}, False, None),
    ],
)
def test_checker_note(ovh, expect_over, verb):
    au = audit()
    au["oracle_vs_hand"] = {"A": {"unverifiable": ovh}}
    n = bt.checker_note(results(), au)
    assert "flags 30 of the LLM's 60 venues" in n and "flags 12 of Rekindle's 70, and 2 when matched by Qloo ID" in n
    assert "(`bench/results.json`, run 2026-10-16 12:34 UTC)" in n
    if expect_over:
        assert f"{ovh['ok']} of the {bt.plural(sum(ovh.values()), 'venue', 'venues')} it couldn't match {verb} real and open" in n
    else:
        assert "over-flags" not in n


def test_checker_note_without_oracle_section():
    au = audit()
    del au["oracle_vs_hand"]
    assert "over-flags" not in bt.checker_note(results(), au)


def test_receipt_with_and_without_tokens():
    r = results()
    s = bt.receipt(r)
    assert "3 Rekindle plans + 2 arm-A model plans; 13 Qloo calls" in s
    assert "10 model calls, 12,345 input + 6,789 output tokens (2 with no usage reported)" in s
    assert "`deterministic`, `qwen:x`" in s and "arm A on `qwen3.8-flash`" in s and "1 errors" in s
    r["tokens"]["unreported"] = 0
    assert "tokens (" not in bt.receipt(r).split("tokens")[1][:5] and "no usage reported" not in bt.receipt(r)
    r["tokens"] = {"llm_calls": 0}
    assert "model tokens not recorded" in bt.receipt(r)
    del r["tokens"]
    assert "model tokens not recorded" in bt.receipt(r)


def test_table_full():
    t = bt.table(results(), replan(), audit())
    lines = t.splitlines()
    assert lines[0].startswith("_Generated by `python3 scripts/bench_table.py` from `bench/results.json` (scripts/bench.py, 20 profiles, 10 in recovery")
    assert "**Wrong** = KILLER-DEF. **Unverifiable**: UNVERIFIABLE-DEF." in t
    assert "| A · LLM only (same model, asked for named venues) | 60 | 60.0% (30) | 6 | 3 | 1 / 25 | 4 | 50.0% (9/18, 2 inconclusive) |" in t
    assert "| B−4 · screen off, 4 bar tags only | 50 | 20.0% (10) | 6 | 3 | 1 / 25 | 4 | — |" in t
    assert "| B−4 · screen off, 4 bar tags only | 200 | 20 (10.0%) | 7 / 40 outings |" in t
    assert "| B · Rekindle | 10 | 20.5 s | 31.2 s | 6.5 |" in t
    assert "(one model call, no Qloo) | 20 | 3.1 s | 5.5 s | 0 |" in t
    assert "**Re-plan responsiveness: 9/10** (`bench/replan.json`). DEF." in t
    assert "Excluded (week 1 too thin to rate): cal, ruby." in t
    assert "At the thread margin (0.02): 8 of those 12, and 7/10 profiles still pass." in t
    assert t.endswith("**Manual audit** (`bench/audit.json`): the build agent (Claude): by hand.")


def test_table_without_thread_margin():
    rp = replan()
    rp["passed_at_thread_margin"] = None
    assert "At the thread margin" not in bt.table(results(), rp, audit())
    del rp["passed_at_thread_margin"]
    assert "At the thread margin" not in bt.table(results(), rp, audit())


# ---------------------------------------------------------------- git-derived pieces

def test_predates_filters_and_orders(root, monkeypatch):
    long_subject = "word " * 40
    git(monkeypatch, log(
        ("1111111aaa", "2026-10-17T10:00:00+00:00", "newer commit"),
        ("f461510bbb", "2026-10-17T09:00:00+00:00", "no behaviour change"),
        ("2222222ccc", "2026-10-16T12:00:00+00:00", "before the bench finished"),
        ("3333333ddd", "2026-10-16T13:00:00+00:00", long_subject.strip()),
    ))
    rows = bt.predates(results())
    assert [r["commit"] for r in rows] == ["3333333", "1111111"]  # oldest first
    assert rows[0]["date"] == "2026-10-16" and rows[0]["subject"].endswith(" …") and len(rows[0]["subject"]) <= 142
    assert rows[1]["subject"] == "newer commit"


def test_predates_uses_since_and_plan_path(root, monkeypatch):
    seen = {}

    def run(cmd, **kw):
        seen["cmd"], seen["cwd"] = cmd, kw["cwd"]
        return SimpleNamespace(stdout="")

    monkeypatch.setattr(bt.subprocess, "run", run)
    assert bt.predates(results()) == []
    assert "--since=2026-10-16T12:34:56+00:00" in seen["cmd"] and seen["cmd"][-len(bt.PLAN_PATH):] == bt.PLAN_PATH and seen["cwd"] == root


@pytest.mark.parametrize("exc", [OSError("no git"), subprocess.CalledProcessError(128, "git")])
def test_git_failures_degrade_quietly(root, monkeypatch, exc):
    git(monkeypatch, exc=exc)
    assert bt.predates(results()) == []
    assert bt.head_sha() == ""


def test_head_sha(root, monkeypatch):
    git(monkeypatch, head="deadbee")
    assert bt.head_sha() == "deadbee"


def test_predates_md():
    assert bt.predates_md([]) == "No plan-path code has changed since this bench run."
    md = bt.predates_md([{"commit": "abc1234", "subject": "fix"}, {"commit": "def5678", "subject": "more"}])
    assert md.splitlines()[0].startswith("**This bench run predates 2 later changes")
    assert md.splitlines()[-2:] == ["- `abc1234` fix", "- `def5678` more"]


# ---------------------------------------------------------------- ember / replace / load

def test_ember_md_missing_file(root):
    assert bt.ember_md() == "Ember threads: `scripts/ember-margins.ts` has not been run yet."


def ember(**kw):
    e = {"generated_at": "2026-10-16T18:00:00Z", "replans": 1, "threshold": 0.02,
         "distinct": {"rating_sets": 2, "cards": 9, "rating_leads_loves": 5, "threaded": 3, "previous_rule_threaded": 4}}
    e.update(kw)
    return e


def test_ember_md_with_and_without_bench(root):
    (root / "bench" / "ember-live.json").write_text(json.dumps(ember(bench={"cards_with_margin": 11, "source": "bench/results.json", "threaded": 6})))
    s = bt.ember_md()
    assert "1 re-plan with 2 distinct rating sets" in s and "2026-10-16 18:00 UTC" in s
    assert "On the bench's 11 new week-2 cards (`bench/results.json`, the same margin), 6 clear it." in s
    assert "3 cleared the 0.02 lead that draws a thread and 2 are shown as ties" in s
    (root / "bench" / "ember-live.json").write_text(json.dumps(ember()))
    assert "On the bench's" not in bt.ember_md()


def test_replace_and_load(root):
    doc = "a <!-- bench:x:start -->old<!-- bench:x:end --> b"
    assert bt.replace(doc, "x", "NEW") == "a <!-- bench:x:start -->\nNEW\n<!-- bench:x:end --> b"
    assert bt.replace(doc, "y", "NEW") == doc
    assert bt.load("replan.json")["result"] == "9/10"


# ---------------------------------------------------------------- stale_files / main

MARKERS = "\n".join(f"<!-- bench:{n}:start -->\nold\n<!-- bench:{n}:end -->" for n in ("killer", "table", "predates", "caveat", "ember")) + "\n"


def docs(root, which=("README.md", "DEMO.md")):
    for name in which:
        (root / name).write_text("# " + name + "\n" + MARKERS)


def test_stale_files_check_then_write(root, monkeypatch):
    docs(root)  # JUDGE.md absent: skipped
    r, rp, au = results(), replan(), audit()
    rows = [{"commit": "abc1234", "date": "2026-10-17", "subject": "s"}]
    assert bt.stale_files(r, rp, au, rows, False) == ["bench/predates.json", "README.md", "DEMO.md"]
    assert not (root / "bench" / "predates.json").exists() and "old" in (root / "README.md").read_text()
    assert bt.stale_files(r, rp, au, rows, True) == ["bench/predates.json", "README.md", "DEMO.md"]
    pj = json.loads((root / "bench" / "predates.json").read_text())
    assert pj["bench_finished_at"] == r["finished_at"] and pj["commits"] == rows and pj["plan_path"] == bt.PLAN_PATH
    readme = (root / "README.md").read_text()
    assert bt.killer(r, au) in readme and "predates 1 later changes" in readme and "Ember threads" in readme
    assert bt.checker_note(r, au) in (root / "DEMO.md").read_text()
    assert bt.stale_files(r, rp, au, rows, True) == []  # idempotent
    (root / "bench" / "predates.json").write_text("{}")  # exists but differs
    assert bt.stale_files(r, rp, au, rows, False) == ["bench/predates.json"]


def test_main_default_updates(root, monkeypatch, capsys):
    docs(root)
    git(monkeypatch, "")
    monkeypatch.setattr("sys.argv", ["bench_table.py"])
    assert bt.main() == 0
    assert capsys.readouterr().out == "updated: bench/predates.json, README.md, DEMO.md\n"
    assert bt.main() == 0
    assert capsys.readouterr().out == "updated: nothing\n"


def test_main_devpost(root, monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["bench_table.py", "--devpost"])
    assert bt.main() == 0
    out = capsys.readouterr().out.splitlines()
    assert out[0].startswith("- **The number:**") and out[1].startswith("- **Ablation**")


@pytest.mark.parametrize("ovh,tail", [({"ok": 2, "wrong": 3}, "5 venues it couldn't match in the audit sample were real and open"), ({"ok": 1}, "1 venue it couldn't match in the audit sample was real and open"), ({}, None)])
def test_devpost_bullets(ovh, tail):
    au = audit()
    au["oracle_vs_hand"] = {"A": {"unverifiable": ovh}}
    number, ablation = bt.devpost_bullets(results(), au)
    assert "got 9 of 18 audited venues wrong (50%: 3 not found, 2 closed at the planned hour, 1 serving alcohol" in number
    assert "flags 30 of 60 vs 12 of 70" in number
    if tail:
        assert f", but {ovh['ok']} of the {tail}" in number
    else:
        assert "but " not in number.split("vs 12 of 70")[1]
    assert "with the screen on, 0 of 40 outing cards" in ablation and "kept: 3 of 40" in ablation and "excluded: 7 of 40" in ablation
    assert "10 in-recovery profiles" in ablation


def test_devpost_without_oracle_section():
    au = audit()
    del au["oracle_vs_hand"]
    assert "but " not in bt.devpost_bullets(results(), au)[0].split("vs 12 of 70")[1]


def prep_current(root, monkeypatch, commits=()):
    docs(root)
    git(monkeypatch, log(*commits))
    monkeypatch.setattr("sys.argv", ["bench_table.py"])
    bt.main()
    monkeypatch.setattr("sys.argv", ["bench_table.py", "--check"])


def test_check_current(root, monkeypatch, capsys):
    prep_current(root, monkeypatch)
    capsys.readouterr()
    assert bt.main() == 0
    assert "bench numbers in README.md / DEMO.md / JUDGE.md match bench/*.json" in capsys.readouterr().out


def test_check_stale(root, monkeypatch, capsys):
    prep_current(root, monkeypatch)
    capsys.readouterr()
    (root / "README.md").write_text("# r\n" + MARKERS)
    assert bt.main() == 1
    assert "stale bench numbers in: README.md (run python3 scripts/bench_table.py)" in capsys.readouterr().err


NEW = ("1111111aaa", "2026-10-17T10:00:00+00:00", "plan change")
NEWER = ("2222222bbb", "2026-10-18T10:00:00+00:00", "later plan change")


def test_check_grace_for_head_plan_commit(root, monkeypatch, capsys):
    # docs generated while only NEW existed; then NEWER lands as HEAD and is not listed yet
    prep_current(root, monkeypatch, [NEW])
    capsys.readouterr()
    git(monkeypatch, log(NEWER, NEW), head="2222222")
    assert bt.main() == 0
    assert "HEAD 2222222 is a plan-path commit not yet listed" in capsys.readouterr().out


def test_check_no_grace_when_older_commit_is_unlisted(root, monkeypatch, capsys):
    prep_current(root, monkeypatch, [NEWER])
    capsys.readouterr()
    git(monkeypatch, log(NEWER, NEW), head="2222222")  # NEW (older) is unlisted; HEAD is NEWER
    assert bt.main() == 1
    assert "stale bench numbers" in capsys.readouterr().err


def test_check_no_grace_when_head_is_not_the_newest_row(root, monkeypatch, capsys):
    prep_current(root, monkeypatch, [NEW])
    capsys.readouterr()
    git(monkeypatch, log(NEWER, NEW), head="9999999")
    assert bt.main() == 1
    capsys.readouterr()
