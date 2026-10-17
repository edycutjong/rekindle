import json
import os
import urllib.error
from types import SimpleNamespace

import pytest
from conftest import Resp, http_error

import replan_check as rc


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(rc.time, "sleep", lambda s: None)


# ---------------------------------------------------------------- call()

def test_call_json_and_headers(monkeypatch):
    seen = {}

    def urlopen(req, timeout):
        seen.update(url=req.full_url, method=req.get_method(), data=req.data, h={k.lower(): v for k, v in req.header_items()}, timeout=timeout)
        return Resp('{"a": 1}')

    monkeypatch.setattr(rc.urllib.request, "urlopen", urlopen)
    assert rc.call("http://b", "TOK", "POST", "/p", {"x": 1}) == (200, {"a": 1})
    assert seen["url"] == "http://b/p" and seen["method"] == "POST" and json.loads(seen["data"]) == {"x": 1} and seen["timeout"] == 120
    assert seen["h"]["x-bench-token"] == "TOK" and seen["h"]["accept"] == "application/json" and seen["h"]["user-agent"] == rc.UA
    rc.call("http://b", "TOK", "GET", "/p", sse=True)
    assert seen["data"] is None and seen["h"]["accept"] == "text/event-stream"


def test_call_http_error_and_non_json(monkeypatch):
    def urlopen(req, timeout):
        raise http_error(409, '{"error": "locked"}')

    monkeypatch.setattr(rc.urllib.request, "urlopen", urlopen)
    assert rc.call("http://b", "T", "GET", "/p") == (409, {"error": "locked"})
    monkeypatch.setattr(rc.urllib.request, "urlopen", lambda r, timeout: Resp("<html>" + "x" * 400))
    st, b = rc.call("http://b", "T", "GET", "/p")
    assert st == 200 and b == {"error": "<html>" + "x" * 294}


def test_call_event_stream(monkeypatch):
    frames = [
        "event: llm\ndata: {}",
        'event: plan\ndata: {"plan": {"id": "P2"}}',
        "event: plan",  # no data
        "just text",    # no event
        'event: error\ndata: {"msg": "late"}',
    ]
    monkeypatch.setattr(rc.urllib.request, "urlopen", lambda r, timeout: Resp("\n\n".join(frames), ctype="text/event-stream"))
    assert rc.call("http://b", "T", "POST", "/replan", {}, sse=True) == (200, {"plan": {"id": "P2"}, "error": {"msg": "late"}})
    monkeypatch.setattr(rc.urllib.request, "urlopen", lambda r, timeout: Resp("event: ping\ndata: 1", ctype="text/event-stream"))
    assert rc.call("http://b", "T", "POST", "/replan", {}) == (200, {"plan": None, "error": None})


# ---------------------------------------------------------------- seed_ratings

def card(cid, rung, aff, eid=None, name=None, explain=()):
    return {"id": cid, "rung": rung, "affinity": aff, "qloo_entity_id": eid or "E-" + cid, "name": name or cid.title(), "explain_json": list(explain)}


def test_seed_ratings_picks_best_home_best_and_worst_outing():
    cards = [card("h1", "home", 0.3), card("h2", "home", 0.9), card("o1", "solo", 0.5), card("o2", "social", 0.8), card("o3", "solo", 0.1)]
    got = rc.seed_ratings(cards)
    assert [(c["id"], p, m) for c, p, m in got] == [("h2", 7, 5), ("o2", 8, 6), ("o3", 2, 3)]


@pytest.mark.parametrize("cards", [[card("o1", "solo", 1), card("h1", "home", 1)], [card("o1", "solo", 1), card("o2", "solo", 1)], []])
def test_seed_ratings_needs_two_outings_and_one_home(cards):
    assert rc.seed_ratings(cards) is None


# ---------------------------------------------------------------- check()

W1_CARDS = [card("h1", "home", 0.9, "H1", "Home1"), card("o1", "solo", 0.8, "O1", "Out1"), card("o2", "social", 0.1, "O2", "Out2")]


def w1(status="draft", **kw):
    return {"id": "P1", "status": status, "cards": W1_CARDS, **kw}


def ex(eid, score, name=None):
    return {"entity_id": eid, "score": score, "name": name or eid}


W2_CARDS = [
    card("n1", "home", 0.5, "N1", "New1", [ex("L", 0.4), ex("H1", 0.5, "Home1")]),   # rating leads by 0.1 -> threaded
    card("n2", "solo", 0.5, "N2", "New2", []),                                         # no explanation
    card("n3", "solo", 0.5, "N3", "New3", [ex("L", 0.9), ex("O1", 0.3)]),              # love leads
    card("n4", "solo", 0.5, "N4", "New4", [ex("O1", 0.7)]),                            # rating-led, no love input
    card("n5", "solo", 0.5, "N5", "New5", [ex("L", 0.31), ex("H1", 0.3)]),             # tiny love lead; rating not top
    card("keep", "home", 0.5, "H1", "Home1", [ex("H1", 1)]),                           # already in week 1
]


class Script:
    """Scripted replacement for rc.call keyed by (method, path-suffix)."""

    def __init__(self, **resp):
        self.resp, self.calls = resp, []

    def __call__(self, base, token, method, path, body=None, timeout=120, sse=False):
        self.calls.append((method, path, body, sse))
        key = f"{method} {path.rsplit('/', 1)[-1]}"
        r = self.resp[key]
        return r(body) if callable(r) else r


def good_script(**over):
    base = {
        "GET P1": (200, {"plan": w1()}),
        "POST approve": (200, {}),
        "POST ratings": (200, {}),
        "POST replan": (200, {"plan": {"id": "P2", "cards": W2_CARDS, "diff": {"kept": [1], "added": [1, 2], "removed": []}}, "error": None}),
    }
    base.update(over)
    return Script(**base)


RUN = {"plan_id": "P1", "profile": "maya"}


def run_check(monkeypatch, script, run=RUN, loves=frozenset({"L"})):
    monkeypatch.setattr(rc, "call", script)
    return rc.check("http://b", "T", run, set(loves))


def test_check_pass_path_computes_margins(monkeypatch):
    s = good_script()
    r = run_check(monkeypatch, s)
    assert [(c[0], c[1]) for c in s.calls] == [("GET", "/api/plans/P1"), ("POST", "/api/plans/P1/approve"), ("POST", "/api/plans/P1/ratings"), ("POST", "/api/plans/P1/replan")]
    assert s.calls[2][2] == {"ratings": [{"card_id": "h1", "pleasure": 7, "mastery": 5}, {"card_id": "o1", "pleasure": 8, "mastery": 6}, {"card_id": "o2", "pleasure": 2, "mastery": 3}]}
    assert s.calls[3][3] is True
    assert r["status"] == "pass" and r["week1_plan"] == "P1" and r["week2_plan"] == "P2"
    assert r["week2_cards"] == 6 and r["new_cards"] == 5
    assert r["attributed_new_cards"] == ["New1", "New4"] and r["threaded_new_cards"] == ["New1"]
    assert r["low_rated_in_week2"] == []
    margins = [c["margin"] for c in r["cards"]]
    assert margins == [0.1, None, -0.6, None, -0.01]
    assert r["margin_median"] == -0.01 and r["margin_min"] == -0.6
    top = {c["name"]: (c["top_input"], c["top_score"], c["rekindled_is_top"]) for c in r["cards"]}
    assert top["New1"] == ("Home1", 0.5, True)  # the top explainability input, by its name
    assert top["New2"] == (None, None, False)
    assert r["rated"][0] == {"name": "Home1", "rung": "home", "pleasure": 7, "mastery": 5}
    assert r["diff_summary"] == {"kept": 1, "added": 2, "removed": 0}
    assert isinstance(r["replan_seconds"], float)


def test_check_skips_approve_when_plan_is_not_a_draft(monkeypatch):
    s = good_script(**{"GET P1": (200, {"plan": w1("approved")})})
    assert run_check(monkeypatch, s)["status"] == "pass"
    assert [c[1].rsplit("/", 1)[-1] for c in s.calls] == ["P1", "ratings", "replan"]


def test_check_fails_when_low_rated_returns_or_nothing_is_attributed(monkeypatch):
    back = W2_CARDS + [card("n6", "solo", 0.1, "O2", "Out2again", [])]  # O2 is the <=3-rated one, but it is in week 1 ids -> skipped as old
    s = good_script(**{"POST replan": (200, {"plan": {"id": "P2", "cards": back, "diff": None}})})
    r = run_check(monkeypatch, s)
    assert r["status"] == "fail" and r["low_rated_in_week2"] == ["Out2again"] and r["diff_summary"] is None
    none_attributed = [card("n2", "solo", 0.5, "N2", "New2", [])]
    s = good_script(**{"POST replan": (200, {"plan": {"id": "P2", "cards": none_attributed, "diff": {"kept": [], "added": [], "removed": []}}})})
    r = run_check(monkeypatch, s)
    assert r["status"] == "fail" and r["attributed_new_cards"] == [] and r["margin_median"] is None and r["margin_min"] is None


def test_check_reports_errors_at_each_step(monkeypatch):
    r = run_check(monkeypatch, good_script(**{"GET P1": (404, {})}))
    assert r == {"profile": "maya", "status": "error", "error": "GET plan 404"}
    r = run_check(monkeypatch, good_script(**{"POST approve": (500, {"error": "x"})}))
    assert r["status"] == "error" and r["error"] == "approve 500 {'error': 'x'}"
    r = run_check(monkeypatch, good_script(**{"POST ratings": (400, {"error": "bad"})}))
    assert r["error"] == "ratings 400 {'error': 'bad'}"
    r = run_check(monkeypatch, good_script(**{"POST ratings": (409, {"error": "locked"})}))
    assert r["error"].startswith("ratings 409")
    r = run_check(monkeypatch, good_script(**{"POST replan": (429, {"plan": None, "error": {"msg": "cap"}})}))
    assert r["error"] == "replan 429 {'msg': 'cap'}"


def test_check_tolerates_409_when_a_next_plan_exists(monkeypatch):
    s = good_script(**{"GET P1": (200, {"plan": w1("approved", next_plan_id="P2")}), "POST ratings": (409, {"error": "already rated"})})
    assert run_check(monkeypatch, s)["status"] == "pass"


def test_check_excludes_thin_weeks(monkeypatch):
    thin = {"id": "P1", "status": "draft", "cards": [card("h1", "home", 1), card("o1", "solo", 1)]}
    r = run_check(monkeypatch, good_script(**{"GET P1": (200, {"plan": thin})}))
    assert r == {"profile": "maya", "status": "excluded", "reason": "week 1 has 1 verified outing(s); the rating rule needs >= 2"}


# ---------------------------------------------------------------- summarise / threaded_of

def row(profile, status, **kw):
    base = {"profile": profile, "status": status}
    if status in ("pass", "fail"):
        base.update(replan_seconds=10.0, low_rated_in_week2=[], attributed_new_cards=["a"], new_cards=2, margin_median=0.05, threaded_new_cards=[])
    base.update(kw)
    return base


def test_threaded_of():
    assert rc.threaded_of({"threaded_new_cards": ["x"]}) == ["x"]
    legacy = {"cards": [
        {"name": "ok", "rekindled_is_top": True, "margin": 0.02},
        {"name": "low", "rekindled_is_top": True, "margin": 0.019},
        {"name": "none", "rekindled_is_top": True, "margin": None},
        {"name": "love", "rekindled_is_top": False, "margin": 0.5},
    ]}
    assert rc.threaded_of(legacy) == ["ok"]
    assert rc.threaded_of({}) == []


def test_summarise_counts_everything():
    rows = [
        row("a", "pass", threaded_new_cards=["t"], margin_median=0.04, replan_seconds=30.0, attributed_new_cards=["a", "b"]),
        row("b", "pass", margin_median=0.06, replan_seconds=10.0),
        row("c", "fail", low_rated_in_week2=["x", "y"], margin_median=None, replan_seconds=20.0, new_cards=5),
        row("d", "excluded", reason="thin"),
        row("e", "error", error="boom"),
        {"profile": "f", "status": "pass", "replan_seconds": 1.0, "low_rated_in_week2": [], "attributed_new_cards": [], "new_cards": 0, "margin_median": 0.1,
         "cards": [{"name": "k", "rekindled_is_top": True, "margin": 0.5}]},   # legacy row without threaded_new_cards
    ]
    s = rc.summarise(rows)
    assert (s["N"], s["passed"], s["result"]) == (4, 3, "3/4")
    assert s["excluded"] == [{"profile": "d", "reason": "thin"}] and s["errors"] == [{"profile": "e", "error": "boom"}] and s["failed"] == ["c"]
    assert s["low_rated_reappearing"] == 2 and s["attributed_new_cards_total"] == 4 and s["new_cards_total"] == 9
    assert s["ember_margin_median_of_profiles"] == 0.06 and s["ember_margin_min_of_profiles"] == 0.04
    assert s["replan_seconds_p50"] == 10.0
    assert s["passed_at_thread_margin"] == 2 and s["threaded_new_cards_total"] == 2 and s["thread_margin"] == 0.02
    assert rows[5]["threaded_new_cards"] == ["k"]  # derived and stored back on the row
    assert "PASS at the thread margin = PASS with at least one such card whose margin is at least 0.02" in s["definition"]


def test_summarise_empty():
    s = rc.summarise([row("e", "error", error="x")])
    assert s["N"] == 0 and s["result"] == "0/0" and s["replan_seconds_p50"] is None
    assert s["ember_margin_median_of_profiles"] is None and s["ember_margin_min_of_profiles"] is None


@pytest.mark.parametrize("secs,p50", [([5.0], 5.0), ([1.0, 9.0], 1.0), ([3.0, 1.0, 2.0], 2.0), ([4.0, 1.0, 3.0, 2.0], 2.0)])
def test_summarise_p50_is_lower_median(secs, p50):
    rows = [row(f"p{i}", "pass", replan_seconds=s) for i, s in enumerate(secs)]
    assert rc.summarise(rows)["replan_seconds_p50"] == p50


# ---------------------------------------------------------------- rescore / main

def test_rescore_rewrites_summary_and_keeps_rows_last(tmp_path, capsys):
    path = tmp_path / "replan.json"
    path.write_text(json.dumps({"generated_by": "x", "base": "keep-me", "result": "stale", "profiles": [row("a", "pass", threaded_new_cards=["t"])]}))
    rc.rescore(str(path))
    d = json.loads(path.read_text())
    assert d["result"] == "1/1" and d["base"] == "keep-me" and d["passed_at_thread_margin"] == 1
    assert list(d)[-1] == "profiles" and path.read_text().endswith("}\n")
    assert f"rescored {path}: 1/1 · at the thread margin 1/1 · threaded new cards 1 of 1 rating-led" in capsys.readouterr().out


def test_main_rescore_default_and_explicit_out(tmp_path, monkeypatch):
    seen = []
    monkeypatch.setattr(rc, "rescore", lambda p: seen.append(p) or "ret")
    monkeypatch.setattr("sys.argv", ["replan_check.py", "--rescore", "--out", "/x/y.json"])
    assert rc.main() == "ret"
    monkeypatch.setattr("sys.argv", ["replan_check.py", "--rescore"])
    rc.main()
    assert seen == ["/x/y.json", os.path.join(rc.ROOT, "bench", "replan.json")]


@pytest.fixture
def live(tmp_path, monkeypatch):
    (tmp_path / "fixtures").mkdir()
    (tmp_path / "bench").mkdir()
    (tmp_path / "fixtures" / "profiles.json").write_text(json.dumps({"profiles": [
        {"slug": "maya", "loves": [{"qloo_id": "L1", "qloo_kind": "entity"}, {"qloo_id": "T1", "qloo_kind": "tag"}]},
        {"slug": "theo", "loves": [{"qloo_id": "L2", "qloo_kind": "entity"}]},
        {"slug": "ana", "loves": []},
    ]}))
    (tmp_path / "bench" / "results.json").write_text(json.dumps({"plans": [
        {"profile": "maya", "arm": "B", "plan_id": "P1"}, {"profile": "theo", "arm": "B", "plan_id": "P2"},
        {"profile": "ana", "arm": "B", "plan_id": "P3"}, {"profile": "maya", "arm": "B-", "plan_id": "PX"}]}))
    monkeypatch.setattr(rc, "ROOT", str(tmp_path))
    monkeypatch.setattr(rc, "require_redis", lambda base: None)
    return tmp_path


def test_main_requires_token(live, monkeypatch):
    monkeypatch.delenv("BENCH_TOKEN", raising=False)
    monkeypatch.setattr("sys.argv", ["replan_check.py", "--base", "http://b"])
    with pytest.raises(SystemExit, match="BENCH_TOKEN is not set"):
        rc.main()


def test_main_runs_arm_b_plans_and_writes_summary(live, monkeypatch, capsys):
    monkeypatch.setenv("BENCH_TOKEN", "TOK")
    guard = []
    monkeypatch.setattr(rc, "require_redis", guard.append)
    seen = {}

    def fake_check(base, token, run, loves):
        seen[run["profile"]] = (base, token, loves)
        if run["profile"] == "maya":
            return row("maya", "pass", threaded_new_cards=["t"])
        if run["profile"] == "theo":
            return {"profile": "theo", "status": "excluded", "reason": "thin"}
        return {"profile": "ana", "status": "error", "error": "boom"}

    monkeypatch.setattr(rc, "check", fake_check)
    monkeypatch.setattr("sys.argv", ["replan_check.py", "--base", "http://b/", "--workers", "1"])
    rc.main()
    assert guard == ["http://b"]
    assert seen == {"maya": ("http://b", "TOK", {"L1"}), "theo": ("http://b", "TOK", {"L2"}), "ana": ("http://b", "TOK", set())}
    out = json.loads((live / "bench" / "replan.json").read_text())
    assert out["generated_by"] == "scripts/replan_check.py" and out["base"] == "http://b" and out["source"] == os.path.join("bench", "results.json")
    assert out["result"] == "1/1" and [p["profile"] for p in out["profiles"]] == ["maya", "theo", "ana"] and list(out)[-1] == "profiles"
    text = capsys.readouterr().out
    assert "  maya   pass     attributed 1/2 new · margin median 0.05 · 10.0 s" in text
    assert "  theo   excluded thin" in text and "  ana    error    boom" in text
    assert "RE-PLAN RESPONSIVENESS 1/1 · at the thread margin 1/1 · excluded ['theo'] · errors 1 · low-rated reappearing 0 · attributed new cards 1/2" in text


def test_main_custom_results_and_out(live, monkeypatch):
    monkeypatch.setenv("BENCH_TOKEN", "TOK")
    other = live / "other.json"
    other.write_text(json.dumps({"plans": []}))
    monkeypatch.setattr("sys.argv", ["replan_check.py", "--base", "http://b", "--results", str(other), "--out", str(live / "o.json")])
    rc.main()
    out = json.loads((live / "o.json").read_text())
    assert out["source"] == "other.json" and out["profiles"] == [] and out["result"] == "0/0"
