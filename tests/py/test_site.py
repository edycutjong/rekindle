import json
from types import SimpleNamespace

import pytest

import importlib.util
import pathlib

# the stdlib `site` module is always loaded first, so scripts/site.py is imported by path
_spec = importlib.util.spec_from_file_location("rekindle_site", pathlib.Path(__file__).resolve().parents[2] / "scripts" / "site.py")
site = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(site)

FINISHED = "2026-10-16T12:34:56+00:00"


def arm(v):
    return {"violations": v, "checked": 18, "inconclusive": 2, "sampled": 20, "rate": v / 18}


def data(commits=(), profiles=20, **over):
    d = {
        "bench/audit.json": {"arms": {"A": arm(9), "B": arm(1)}},
        "bench/results.json": {
            "finished_at": FINISHED, "profiles": [{}] * profiles if profiles != 20 else 20,
            "ablation_in_recovery": {"profiles": 0, **{k: {"plan_alcohol_leak": n, "outing_cards": 40, "pool_candidates": 200, "pool_alcohol": 20, "profiles": 10} for k, n in (("B", 0), ("B-", 4), ("B-4", 10))}},
            "latency": {"B": {"client_p50_s": 20.5, "client_p95_s": 31.25, "qloo_calls_mean": 6.5}},
        },
        "bench/replan.json": {"passed": 9, "N": 10, "low_rated_reappearing": 0, "passed_at_thread_margin": 7, "excluded": ["a", "b"]},
        "bench/predates.json": {"bench_finished_at": FINISHED, "commits": list(commits)},
        "docs/rigor.json": {"tests": 300, "files": 25, "defect_named": 40, "property_cases": 12000, "properties": 12, "runs_per_property": 1000},
    }
    d.update(over)
    return d


def build(root, d):
    for rel, obj in d.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(obj))


PAGE = """<html><body>
<p>Hand check: <span data-n="hand.A.wrong">0</span> of <b data-n="hand.A.checked">0</b>, rate <i data-n="hand.A.rate">x</i></p>
<p data-n="bench.caveat">old</p>
<i data-w="abl.B-4" class="bar" style="--w:1%"></i><i data-w="abl.B" style="--w:5%"></i>
<span data-boxes="A" class="b" aria-label="old label"><i class="bx"></i></span>
<span data-boxes="B" aria-label="x">junk</span>
<span class="ver">v0.0.1</span>
<img alt="chart 777" src="x.png"><a title="tip 888">link</a>
<style>.x{width:999px}</style><script>var n = 123456;</script><!-- 424242 -->
</body></html>
"""


@pytest.fixture
def root(tmp_path, monkeypatch):
    build(tmp_path, data())
    for rel in site.EVIDENCE:
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        if not p.exists():
            p.write_text("")
    monkeypatch.setattr(site, "ROOT", tmp_path)
    monkeypatch.setattr(site, "PAGES", [tmp_path / "public" / "about.html", tmp_path / "public" / "pitch.html"])
    (tmp_path / "public").mkdir(exist_ok=True)
    return tmp_path


def git_tag(monkeypatch, rc=0, out="v1.2.3\n"):
    monkeypatch.setattr(site.subprocess, "run", lambda cmd, **kw: SimpleNamespace(returncode=rc, stdout=out))


# ---------------------------------------------------------------- facts

def test_facts_values(root):
    f, au = site.facts()
    assert au["arms"]["A"]["violations"] == 9
    assert f["hand.A.wrong"] == "9" and f["hand.A.rate"] == "50.0%" and f["hand.B.rate"] == "5.6%"
    assert f["hand.A.checked"] == "18" and f["hand.A.inconclusive"] == "2" and f["hand.B.sampled"] == "20"
    assert (f["abl.B-4.leak"], f["abl.B-4.cards"], f["abl.B-.pool"], f["abl.B-.flagged"]) == ("10", "40", "200", "20")
    assert f["abl.profiles"] == "10"
    assert (f["replan.passed"], f["replan.N"], f["replan.passed_thread"], f["replan.excluded"], f["replan.low_back"]) == ("9", "10", "7", "2", "0")
    assert (f["lat.p50"], f["lat.p95"], f["lat.calls"]) == ("20.50 s", "31.25 s", "6.5")
    assert f["bench.profiles"] == "20"
    assert f["bench.day"] == "16 Oct 2026" and f["bench.utc"] == "2026-10-16 12:34 UTC"
    assert f["bench.predates"] == "0" and f["bench.caveat"] == "Bench run of 16 Oct 2026; no plan-path code has changed since."
    assert (f["rigor.tests"], f["rigor.files"], f["rigor.defect"], f["rigor.cases"], f["rigor.properties"], f["rigor.runs"]) == ("300", "25", "40", "12,000", "12", "1,000")
    assert all(isinstance(v, str) for v in f.values())


@pytest.mark.parametrize(
    "commits,expected",
    [
        ([{"c": 1}], "The bench run of 16 Oct 2026 predates 1 later plan-path change (listed in DEMO.md)."),
        ([{"c": 1}, {"c": 2}], "The bench run of 16 Oct 2026 predates 2 later plan-path changes (listed in DEMO.md)."),
        (3, "The bench run of 16 Oct 2026 predates 3 later plan-path changes (listed in DEMO.md)."),
    ],
)
def test_facts_caveat_counts(root, commits, expected):
    build(root, {"bench/predates.json": {"bench_finished_at": FINISHED, "commits": commits}})
    f, _ = site.facts()
    assert f["bench.caveat"] == expected and f["bench.predates"] == str(len(commits) if isinstance(commits, list) else commits)


def test_facts_profiles_as_list_counts_entries(root):
    res = data(profiles=7)["bench/results.json"]
    build(root, {"bench/results.json": res})
    assert site.facts()[0]["bench.profiles"] == "7"


def test_facts_rejects_predates_for_another_run(root):
    build(root, {"bench/predates.json": {"bench_finished_at": "2020-01-01T00:00:00+00:00", "commits": []}})
    with pytest.raises(SystemExit, match="predates.json is not for bench/results.json"):
        site.facts()


# ---------------------------------------------------------------- latest_tag / boxes / render

@pytest.mark.parametrize("rc,out,expected", [(0, "v1.2.3\n", "v1.2.3"), (0, "  \n", None), (128, "", None), (128, "v9", None)])
def test_latest_tag(monkeypatch, rc, out, expected):
    git_tag(monkeypatch, rc, out)
    assert site.latest_tag() == expected


def test_boxes_struck_ok_inconclusive():
    assert site.boxes({"checked": 5, "violations": 2, "inconclusive": 1}) == '<i class="bx x"></i>' * 2 + '<i class="bx"></i>' * 3 + '<i class="bx q"></i>'


def test_render_replaces_everything(root):
    f, au = site.facts()
    out = site.render(PAGE, f, au, tag="v1.2.3")
    assert '<span data-n="hand.A.wrong">9</span>' in out and '<b data-n="hand.A.checked">18</b>' in out and '<i data-n="hand.A.rate">50.0%</i>' in out
    assert '<p data-n="bench.caveat">Bench run of 16 Oct 2026; no plan-path code has changed since.</p>' in out
    assert 'style="--w:25.0%"' in out and 'style="--w:0.0%"' in out
    assert 'aria-label="20 venues sampled: 9 wrong, 9 right, 2 inconclusive"' in out
    assert 'aria-label="20 venues sampled: 1 wrong, 17 right, 2 inconclusive"' in out
    assert out.count('<i class="bx x"></i>') == 10 and 'junk' not in out
    assert '<span class="ver">v1.2.3</span>' in out
    assert site.render(out, f, au, tag="v1.2.3") == out  # idempotent


def test_render_without_tag_keeps_version(root):
    f, au = site.facts()
    assert '<span class="ver">v0.0.1</span>' in site.render(PAGE, f, au)


def test_render_escapes_values_and_rejects_unknown_keys(root):
    f, au = site.facts()
    f["hand.A.rate"] = "<b>&"
    assert '<i data-n="hand.A.rate">&lt;b&gt;&amp;</i>' in site.render(PAGE, f, au)
    with pytest.raises(SystemExit, match="unknown data-n key 'nope'"):
        site.render('<i data-n="nope">1</i>', f, au)


# ---------------------------------------------------------------- numbers

def test_visible_numbers_ignores_scripts_styles_comments():
    nums = site.visible_numbers(PAGE)
    assert {"777", "888"} <= nums            # alt / title attributes are visible
    assert not ({"999", "123456", "424242"} & nums)
    assert site.visible_numbers("<p>1,234 and 3.5 and 12:30 and a1 and v2.0 x 7</p>") == {"1,234", "3.5", "12:30", "7"}
    assert site.visible_numbers("<p>&#49;&#50;</p>") == {"12"}


def test_evidence_numbers_reads_docs_and_bench_json(root):
    (root / "README.md").write_text("we ran 4242 tests")
    (root / "bench" / "extra.json").write_text('{"n": 5151}')
    ev = site.evidence_numbers()
    assert {"4242", "5151", "300"} <= ev


# ---------------------------------------------------------------- main

def back_every_number(root, page_text):
    f, au = site.facts()
    nums = site.visible_numbers(site.render(page_text, f, au, None))
    (root / "README.md").write_text(" ".join(sorted(nums)))


def test_main_writes_pages_and_check_agrees(root, monkeypatch, capsys):
    git_tag(monkeypatch, 128, "")
    (root / "public" / "about.html").write_text(PAGE)
    back_every_number(root, PAGE)  # pitch.html is absent and skipped
    monkeypatch.setattr("sys.argv", ["site.py"])
    site.main()
    out = capsys.readouterr().out
    assert out.startswith("site: ") and out.endswith("on 1 pages, each backed by a committed file; pages written\n")
    assert 'data-n="hand.A.wrong">9<' in (root / "public" / "about.html").read_text()
    monkeypatch.setattr("sys.argv", ["site.py", "--check"])
    site.main()
    out = capsys.readouterr().out
    assert out.endswith("each backed by a committed file\n") and "pages written" not in out


def test_check_flags_stale_page_without_writing(root, monkeypatch, capsys):
    git_tag(monkeypatch, 128, "")
    (root / "public" / "about.html").write_text(PAGE)
    (root / "public" / "pitch.html").write_text(PAGE)
    back_every_number(root, PAGE)
    monkeypatch.setattr("sys.argv", ["site.py", "--check"])
    with pytest.raises(SystemExit) as e:
        site.main()
    assert e.value.code == 1
    out = capsys.readouterr().out
    assert "site: public/about.html is stale; run python3 scripts/site.py" in out and "site: public/pitch.html is stale" in out
    assert (root / "public" / "about.html").read_text() == PAGE


def test_unbacked_number_fails_even_when_pages_are_written(root, monkeypatch, capsys):
    git_tag(monkeypatch, 0, "v1.0.0\n")
    page = PAGE + "<p>We served 31337 users</p>"
    (root / "public" / "about.html").write_text(page)
    back_every_number(root, PAGE)
    monkeypatch.setattr("sys.argv", ["site.py"])
    with pytest.raises(SystemExit) as e:
        site.main()
    assert e.value.code == 1
    assert "site: no evidence file shows the number public/about.html: 31337" in capsys.readouterr().out
    assert '<span class="ver">v1.0.0</span>' in (root / "public" / "about.html").read_text()  # rewritten before the failure
