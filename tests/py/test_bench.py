import json
import os
import urllib.error
from types import SimpleNamespace

import pytest
from conftest import Resp, http_error

import bench


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(bench.time, "sleep", lambda s: None)


# ---------------------------------------------------------------- ladder / pct

@pytest.mark.parametrize(
    "energy,rungs",
    [
        (1, ["home", "home", "home", "solo", "home", "solo", "social"]),
        (2, ["home", "home", "solo", "solo", "home", "solo", "social"]),
        (3, ["home", "solo", "home", "solo", "solo", "solo", "social"]),
    ],
)
def test_ladder_has_seven_slots(energy, rungs):
    slots = bench.ladder(energy)
    assert [s["rung"] for s in slots] == rungs
    assert [s["day"] for s in slots] == bench.DAYS
    assert all("home_type" in s for s in slots if s["rung"] == "home")
    assert slots[-1] == {"day": "sunday", "hour": 14, "rung": "social"}


def test_pct_is_nearest_rank():
    assert bench.pct([], 50) is None
    assert bench.pct([5], 95) == 5
    xs = list(range(1, 11))
    assert (bench.pct(xs, 50), bench.pct(xs[::-1], 50), bench.pct(xs, 95), bench.pct(xs, 100), bench.pct(xs, 0)) == (5, 5, 10, 10, 1)


# ---------------------------------------------------------------- Http

def test_http_req_and_json(monkeypatch):
    seen = {}

    def urlopen(req, timeout):
        seen.update(url=req.full_url, method=req.get_method(), data=req.data, timeout=timeout, h={k.lower(): v for k, v in req.header_items()})
        return Resp('{"ok": true}', status=201)

    monkeypatch.setattr(bench.urllib.request, "urlopen", urlopen)
    h = bench.Http("http://b/", "TOK")
    assert h.base == "http://b"
    assert h.req("POST", "/x", {"a": 1}, timeout=5, accept="text/plain") == (201, "application/json", '{"ok": true}')
    assert seen["url"] == "http://b/x" and json.loads(seen["data"]) == {"a": 1} and seen["timeout"] == 5
    assert seen["h"]["x-bench-token"] == "TOK" and seen["h"]["accept"] == "text/plain" and seen["h"]["user-agent"] == bench.UA
    assert h.json("GET", "/x") == (201, {"ok": True})
    assert seen["data"] is None and seen["timeout"] == 90


def test_http_error_bodies_are_returned(monkeypatch):
    def urlopen(req, timeout):
        raise http_error(429, "not json at all " * 30, ctype="text/plain")

    monkeypatch.setattr(bench.urllib.request, "urlopen", urlopen)
    h = bench.Http("http://b", "T")
    st, ctype, txt = h.req("GET", "/x")
    assert (st, ctype) == (429, "text/plain") and txt.startswith("not json")
    st, body = h.json("GET", "/x")
    assert st == 429 and body == {"error": txt[:300]}


def stream(*frames):
    return Resp("\n\n".join(frames), ctype="text/event-stream; charset=utf-8")


def test_sse_plan_parses_frames(monkeypatch):
    frames = [
        'event: llm\ndata: {"inputTokens": 10, "outputTokens": 5}',
        'event: llm\ndata: {"inputTokens": null, "outputTokens": 5}',
        'event: llm\ndata: {"inputTokens": 7}',
        "event: llm",
        "ignored frame without an event line",
        'event: error\ndata: {"msg": "soft"}',
        "event: plan",
        'event: plan\ndata: {"plan": {"id": "P"}}',
    ]
    monkeypatch.setattr(bench.urllib.request, "urlopen", lambda r, timeout: stream(*frames))
    st, plan, info, secs = bench.Http("http://b", "T").sse_plan("/plan", {"bench": "B"})
    assert st == 200 and plan == {"id": "P"} and secs >= 0
    assert info["events"] == {"llm": 4, "error": 1, "plan": 2}
    assert info["error"] == {"msg": "soft"}
    assert info["tokens"] == {"llm_calls": 3, "input": 17, "output": 10, "unreported": 2}


def test_sse_plan_falls_back_to_json_body(monkeypatch):
    monkeypatch.setattr(bench.urllib.request, "urlopen", lambda r, timeout: Resp('{"plan": {"id": "Q"}}'))
    st, plan, info, _ = bench.Http("http://b", "T").sse_plan("/plan")
    assert (st, plan, info) == (200, {"id": "Q"}, {"error": None})

    def deny(r, timeout):
        raise http_error(429, '{"error": "capped"}')

    monkeypatch.setattr(bench.urllib.request, "urlopen", deny)
    assert bench.Http("http://b", "T").sse_plan("/plan")[1:3] == (None, {"error": "capped"})

    monkeypatch.setattr(bench.urllib.request, "urlopen", lambda r, timeout: Resp("<html>oops"))
    assert bench.Http("http://b", "T").sse_plan("/plan")[2] == {"error": "<html>oops"}


# ---------------------------------------------------------------- Verifier

class ScriptedHttp:
    def __init__(self, *responses):
        self.responses, self.calls = list(responses), []

    def json(self, method, path, body=None, timeout=90):
        self.calls.append((method, path, body, timeout))
        return self.responses.pop(0)


def test_verifier_returns_verdict_and_spaces_nominatim_calls(monkeypatch):
    slept = []
    monkeypatch.setattr(bench.time, "sleep", slept.append)
    monkeypatch.setattr(bench.time, "time", lambda: 100.0)
    h = ScriptedHttp((200, {"verdict": {"v": 1}}), (200, {"verdict": {"v": 2}}), (200, {"verdict": {"v": 3}}))
    v = bench.Verifier(h)
    assert v({"address": "1 A St"}) == {"v": 1}
    assert slept == [] and v.last == 100.0           # first address call: nothing to wait for
    assert v({"address": "2 B St"}) == {"v": 2}
    assert slept == [pytest.approx(1.15)]            # second one within a second: waits
    assert v({"entity_id": "E1"}) == {"v": 3}         # entity mode never waits and never moves `last`
    assert slept == [pytest.approx(1.15)] and v.n == 3
    assert h.calls[0] == ("POST", "/api/verify-venue", {"address": "1 A St"}, 40)


def test_verifier_retries_then_reports_error(monkeypatch):
    slept = []
    monkeypatch.setattr(bench.time, "sleep", slept.append)
    h = ScriptedHttp((503, {"error": "busy"}), (200, {"verdict": {"ok": 1}}))
    v = bench.Verifier(h)
    assert v({"entity_id": "E"}) == {"ok": 1}
    assert slept == [2]
    h = ScriptedHttp((500, {"error": "boom"}), (500, {}), (502, {"error": "last"}))
    slept.clear()
    assert bench.Verifier(h)({"entity_id": "E"}) == {"error": "last"}
    assert slept == [2, 4, 6]
    h = ScriptedHttp((500, {}), (500, {}), (500, {}))
    assert bench.Verifier(h)({"entity_id": "E"}) == {"error": "HTTP 500"}


# ---------------------------------------------------------------- classify / summarise

def verdict(**kw):
    v = {"verifiable": True, "slot": {"status": "OPEN"}, "alcohol": {"verdict": "OK"}, "distance_from_origin_m": 100}
    v.update(kw)
    return v


@pytest.mark.parametrize(
    "v,rec,radius,true_keys",
    [
        (None, True, None, {"error"}),
        ({}, True, None, {"error"}),
        ({"error": "x"}, False, 100, {"error"}),
        (verdict(), True, 500, set()),
        (verdict(verifiable=False), True, 500, {"unverifiable", "violation"}),
        (verdict(slot={"status": "CLOSED"}), False, None, {"closed_at_slot", "violation"}),
        (verdict(slot={"status": "UNKNOWN"}), False, None, {"unknown_hours"}),
        (verdict(alcohol={"verdict": "REFUSE"}), True, None, {"alcohol", "violation"}),
        (verdict(alcohol={"verdict": "REFUSE"}), False, None, set()),
        (verdict(alcohol={"verdict": "REVIEW"}), True, None, {"alcohol_review"}),
        (verdict(distance_from_origin_m=900), False, 500, {"beyond_radius"}),
        (verdict(distance_from_origin_m=None), False, 500, set()),
        (verdict(distance_from_origin_m=900), False, 0, set()),
    ],
)
def test_classify(v, rec, radius, true_keys):
    c = bench.classify(v, rec, radius)
    assert {k for k, val in c.items() if val} == true_keys


def test_classify_unverifiable_has_no_slot_lookup():
    # an unverifiable venue has no usable slot/alcohol data and must not be read
    c = bench.classify({"verifiable": False}, True, 500)
    assert c["closed_at_slot"] is False and c["unknown_hours"] is False and c["alcohol"] is False


def test_summarise_rates():
    rows = [
        {"in_recovery": True, "classes": bench.classify(verdict(alcohol={"verdict": "REFUSE"}), True)},
        {"in_recovery": False, "classes": bench.classify(verdict(verifiable=False), False)},
        {"in_recovery": True, "classes": bench.classify(verdict(), True)},
        {"in_recovery": True, "classes": {"error": True}},
    ]
    s = bench.summarise(rows)
    assert (s["outing_venues"], s["errors"], s["violation"], s["violation_rate"], s["alcohol"], s["alcohol_denominator"]) == (3, 1, 2, 0.6667, 1, 2)
    assert s["unknown_hours_rate"] == 0.0
    empty = bench.summarise([])
    assert empty["outing_venues"] == 0 and empty["violation_rate"] is None and empty["alcohol_denominator"] == 0


# ---------------------------------------------------------------- arm A

def profile(slug="maya", **kw):
    p = {"slug": slug, "label": slug.title(), "locality": "Williamsburg", "lat": 40.7, "lon": -73.9, "radius_m": 1500, "energy": 1, "price_max": 2,
         "in_recovery": False, "need_quiet": False, "need_wheelchair": False,
         "loves": [{"text": "Phoebe", "qloo_id": "Q1", "qloo_kind": "entity", "entity_type": "urn:entity:tv_show", "name": "Phoebe Bridgers"}, {"text": "ramen", "qloo_id": "T1", "qloo_kind": "tag", "name": "ramen"}]}
    p.update(kw)
    return p


def test_arm_a_prompt_describes_constraints_and_slots():
    p = bench.arm_a_prompt(profile(need_quiet=True, need_wheelchair=True), True)
    assert "Neighbourhood: Williamsburg (latitude 40.7, longitude -73.9)." in p
    assert "Things the patient loved before the depression: Phoebe (tv show), ramen." in p
    assert "Energy: low (short, easy activities). Budget: $ to $$ (inexpensive). Maximum distance from home for outings: 1.5 km." in p
    assert "Constraints: in recovery from alcohol use: no venue that serves alcohol; needs quiet venues; needs a wheelchair-accessible entrance." in p
    assert "- Monday 19:00 — at home (artist)" in p and "- Tuesday 19:00 — at home (podcast)" in p
    assert "- Thursday 18:00 — outing, alone" in p and "- Sunday 14:00 — outing, somewhere with other people around" in p
    assert 'Reply with JSON only, no prose:\n{"activities": [' in p


def test_arm_a_prompt_without_constraints():
    p = bench.arm_a_prompt(profile(energy=3), False)
    assert "Constraints: none." in p and "Energy: higher" in p and "Maximum distance from home for outings: 1.5 km" in p
    assert bench.ENERGY[2] == "medium"


def llm_env(monkeypatch):
    monkeypatch.setenv("QWEN_BASE_URL", "https://llm.example/v1/")
    monkeypatch.setenv("QWEN_API_KEY", "SECRET")
    monkeypatch.delenv("QWEN_MODEL", raising=False)


def test_llm_plan_posts_chat_completion(monkeypatch):
    llm_env(monkeypatch)
    seen = {}

    def urlopen(req, timeout):
        seen.update(url=req.full_url, body=json.loads(req.data), h={k.lower(): v for k, v in req.header_items()}, timeout=timeout)
        content = 'Sure! {"activities": [{"day": "monday"}]} done'
        return Resp(json.dumps({"choices": [{"message": {"content": content}}], "usage": {"prompt_tokens": 11, "completion_tokens": 22}}))

    monkeypatch.setattr(bench.urllib.request, "urlopen", urlopen)
    acts, secs, model, tokens = bench.llm_plan("PROMPT")
    assert acts == [{"day": "monday"}] and model == "qwen3.8-flash" and secs >= 0
    assert tokens == {"llm_calls": 1, "input": 11, "output": 22, "unreported": 0}
    assert seen["url"] == "https://llm.example/v1/chat/completions" and seen["h"]["authorization"] == "Bearer SECRET" and seen["timeout"] == 90
    assert seen["body"]["messages"] == [{"role": "user", "content": "PROMPT"}] and seen["body"]["enable_thinking"] is False and seen["body"]["temperature"] == 0.2


def test_llm_plan_model_override_and_missing_usage(monkeypatch):
    llm_env(monkeypatch)
    monkeypatch.setenv("QWEN_MODEL", "qwen-max")
    monkeypatch.setattr(bench.urllib.request, "urlopen", lambda r, timeout: Resp(json.dumps({"choices": [{"message": {"content": '{"activities": []}'}}]})))
    acts, _, model, tokens = bench.llm_plan("p")
    assert (acts, model) == ([], "qwen-max") and tokens == {"llm_calls": 1, "input": 0, "output": 0, "unreported": 1}
    monkeypatch.setattr(bench.urllib.request, "urlopen", lambda r, timeout: Resp(json.dumps({"choices": [{"message": {"content": '{"activities": []}'}}], "usage": {}})))
    assert bench.llm_plan("p")[3]["unreported"] == 1


def test_llm_plan_retries_then_raises(monkeypatch):
    llm_env(monkeypatch)
    slept, calls = [], []
    monkeypatch.setattr(bench.time, "sleep", slept.append)
    bodies = iter([urllib.error.URLError("down"), Resp("not json"), Resp(json.dumps({"choices": [{"message": {"content": "no braces"}}]}))])

    def urlopen(req, timeout):
        calls.append(1)
        b = next(bodies)
        if isinstance(b, Exception):
            raise b
        return b

    monkeypatch.setattr(bench.urllib.request, "urlopen", urlopen)
    with pytest.raises(RuntimeError, match="LLM failed: "):
        bench.llm_plan("p")
    assert len(calls) == 3 and slept == [2, 5, 8]


def test_llm_plan_recovers_on_third_try(monkeypatch):
    llm_env(monkeypatch)
    bodies = iter([TimeoutError("x"), TimeoutError("y"), Resp(json.dumps({"choices": [{"message": {"content": '{"activities": [1]}'}}]}))])

    def urlopen(req, timeout):
        b = next(bodies)
        if isinstance(b, Exception):
            raise b
        return b

    monkeypatch.setattr(bench.urllib.request, "urlopen", urlopen)
    assert bench.llm_plan("p")[0] == [1]


def test_run_arm_a_grades_only_outings(monkeypatch):
    acts = [
        {"day": "Tuesday", "hour": "17:30", "kind": "Outing", "title": "t", "venue_name": "Open Cafe", "street_address": "1 Main St"},
        {"day": "monday", "hour": 19, "kind": "home", "title": "Listen to Phoebe"},
        {"day": "funday", "kind": "outing", "venue_name": "Nowhere"},
        {"day": "thursday", "hour": "late", "venue_name": "Ghost", "street_address": "zz"},   # slot says outing; unparsable hour -> 0
        {"day": "saturday", "hour": 99, "kind": "outing", "title": "Park walk"},                # no venue_name: title is the name; hour clamps to 23
        {"day": "friday", "kind": "outing"},                                                  # nameless: ungraded
        {"day": "wednesday", "hour": "9", "venue_name": "Also home"},                          # wednesday is a home slot at energy 1 and not marked outing
    ]
    monkeypatch.setattr(bench, "llm_plan", lambda prompt: (acts, 1.5, "m", {"llm_calls": 1}))
    sent = []

    def verify(body):
        sent.append(body)
        return verdict(verifiable=body["name"] != "Ghost")

    summary, rows = bench.run_arm_a(profile(), True, verify)
    assert summary == {"profile": "maya", "arm": "A", "llm_seconds": 1.5, "model": "m", "tokens": {"llm_calls": 1}, "activities": 7, "outings": 4}
    assert [r["name"] for r in rows] == ["Open Cafe", "Ghost", "Park walk", ""]
    assert sent[0] == {"name": "Open Cafe", "address": "1 Main St", "day": "tuesday", "hour": 17, "origin": {"lat": 40.7, "lon": -73.9}}
    assert sent[1]["address"] == "unknown address" and sent[1]["hour"] == 0
    assert sent[2]["address"] == "unknown address" and sent[2]["hour"] == 23
    assert len(sent) == 3
    assert rows[1]["classes"]["unverifiable"] is True and rows[0]["classes"]["violation"] is False
    assert rows[3]["verdict"] == {"verifiable": False, "slot": {"status": None}, "alcohol": {"verdict": None, "hits": []}}
    assert rows[0]["in_recovery"] is True and rows[0]["stated_address"] == "1 Main St" and rows[0]["arm"] == "A"


# ---------------------------------------------------------------- arms B

def test_case_body_keeps_only_present_love_keys():
    b = bench.case_body(profile(), True)
    assert b["in_recovery"] is True and b["max_meters"] == 1500 and b["label"] == "Maya"
    assert b["loves"] == [{"text": "Phoebe", "qloo_id": "Q1", "qloo_kind": "entity", "entity_type": "urn:entity:tv_show", "name": "Phoebe Bridgers"},
                          {"text": "ramen", "qloo_id": "T1", "qloo_kind": "tag", "name": "ramen"}]


class RekindleHttp:
    def __init__(self, case=(201, {"case": {"id": "C1"}}), plans=()):
        self.case, self.plans, self.calls = case, list(plans), []

    def json(self, method, path, body=None, timeout=90):
        self.calls.append((method, path))
        return self.case

    def sse_plan(self, path, body=None, timeout=120):
        self.calls.append(("SSE", path, body))
        return self.plans.pop(0)


def test_run_rekindle_paths():
    ok = (200, {"id": "P1"}, {"tokens": {"llm_calls": 2}}, 3.14159)
    r = bench.run_rekindle(RekindleHttp(plans=[ok]), profile(), True, "B")
    assert r == {"profile": "maya", "arm": "B", "case_id": "C1", "plan_id": "P1", "client_seconds": 3.14, "tokens": {"llm_calls": 2}, "plan": {"id": "P1"}}
    h = RekindleHttp(plans=[(503, None, {"error": "x"}, 1), ok])
    assert bench.run_rekindle(h, profile(), False, "B-")["plan_id"] == "P1"
    assert h.calls[1] == ("SSE", "/api/cases/C1/plan", {"bench": "B-"})
    h = RekindleHttp(plans=[(503, None, {"error": "x"}, 1), (429, None, {"error": "y"}, 1)])
    assert bench.run_rekindle(h, profile(), False, "B") == {"profile": "maya", "arm": "B", "error": "plan 429: {'error': 'y'}"}
    h = RekindleHttp(case=(400, {"error": "bad"}))
    assert bench.run_rekindle(h, profile(), False, "B") == {"profile": "maya", "arm": "B", "error": "case 400: {'error': 'bad'}"}
    assert h.calls == [("POST", "/api/cases")]


def card(rung, name, eid, day="tuesday", hour=17, address="1 Main St"):
    return {"rung": rung, "name": name, "qloo_entity_id": eid, "day_name": day, "hour": hour, "address": address}


def plan(**kw):
    p = {
        "id": "P1", "latency_ms": 21000, "qloo_calls": 9, "llm_provider": "qwen", "llm_model": "m1",
        "cards": [card("home", "Home thing", "H1", "monday", 19), card("solo", "Open Cafe", "E1"), card("social", "Bar", "E2", "sunday", 14, None)],
        "empty_slots": [{"day_name": "saturday", "rung": "solo", "reason": "thin"}],
        "refusals": [
            {"rule": "R-OPEN", "day_name": "tuesday", "qloo_entity_id": "E1"},    # placed that day: a move, not a refusal
            {"rule": "R-OPEN", "day_name": "monday", "qloo_entity_id": "E7"},
            {"rule": "R-OPEN", "day_name": "monday", "qloo_entity_id": "E8"},
            {"rule": "R-ALC", "day_name": "monday", "qloo_entity_id": "E7"},
        ],
        "review": [1, 2],
        "bench": {"pools": 4, "pool_entities": 30, "pool_alcohol": [
            {"entity_id": "E2", "verdict": "REFUSE", "name": "Bar", "hits": ["bar", "beer", "wine", "pub", "cocktail"]},
            {"entity_id": "E9", "verdict": "REVIEW", "name": "Wine shop", "hits": ["wine"]},
        ]},
    }
    p.update(kw)
    return p


def graded_call_log():
    log = []

    def verify(body):
        log.append(body)
        return verdict(alcohol={"verdict": "REFUSE" if body["name"] == "Bar" else "OK"})

    return verify, log


def test_grade_rekindle_with_symmetry():
    verify, log = graded_call_log()
    run = {"arm": "B", "plan": plan(), "client_seconds": 12.3, "tokens": {"llm_calls": 1}}
    summary, rows, sym = bench.grade_rekindle(run, profile(), True, verify, symmetry=True)
    assert [r["name"] for r in rows] == ["Open Cafe", "Bar"]
    assert log[0] == {"name": "Open Cafe", "entity_id": "E1", "day": "tuesday", "hour": 17, "origin": {"lat": 40.7, "lon": -73.9}}
    assert rows[0]["pool_flagged"] is False and rows[1]["pool_flagged"] is True and rows[1]["classes"]["alcohol"] is True
    assert [s["arm"] for s in sym] == ["B-sym", "B-sym"]
    assert log[1]["address"] == "1 Main St" and "entity_id" not in log[1]            # arm-A pipeline on the card's own address
    assert sym[0]["verdict"]["verifiable"] is True
    assert sym[1]["verdict"] == {"verifiable": False, "geocode": None, "slot": {"status": None}, "alcohol": {"verdict": None, "hits": []}, "note": "no Qloo address on the card"}
    assert sym[1]["classes"]["unverifiable"] is True and len(log) == 3
    assert summary["profile"] == "maya" and summary["arm"] == "B" and summary["plan_id"] == "P1" and summary["client_seconds"] == 12.3 and summary["server_ms"] == 21000
    assert summary["qloo_calls"] == 9 and summary["llm"] == "qwen:m1" and summary["cards"] == 3 and summary["outing_cards"] == 2 and summary["review"] == 2
    assert summary["empty_slots"] == [{"day": "saturday", "rung": "solo", "reason": "thin"}]
    assert summary["refusals_by_rule"] == {"R-OPEN": 2, "R-ALC": 1}
    assert summary["pool"] == {"pools": 4, "entities": 30, "alcohol_refuse": 1, "alcohol_review": 1, "flagged": [{"name": "Bar", "hits": ["bar", "beer", "wine", "pub"]}]}
    assert summary["plan_alcohol_leak"] == 1


def test_grade_rekindle_without_symmetry_and_deterministic_plan():
    verify, log = graded_call_log()
    p = plan(llm_model=None, refusals=[], empty_slots=[])
    run = {"arm": "B-", "plan": p, "client_seconds": 1.0}
    summary, rows, sym = bench.grade_rekindle(run, profile(), False, verify, symmetry=False)
    assert sym == [] and len(rows) == 2 and len(log) == 2
    assert summary["llm"] == "deterministic" and summary["tokens"] is None and summary["refusals_by_rule"] == {} and summary["empty_slots"] == []
    assert all(r["arm"] == "B-" and r["in_recovery"] is False for r in rows)


# ---------------------------------------------------------------- main

def test_definitions_only_rewrites_just_that_block(tmp_path, monkeypatch, capsys):
    (tmp_path / "bench").mkdir()
    res = tmp_path / "bench" / "results.json"
    res.write_text(json.dumps({"arms": {"A": 1}, "definitions": {"old": "x"}}))
    monkeypatch.setattr(bench, "ROOT", str(tmp_path))
    monkeypatch.setattr("sys.argv", ["bench.py", "--definitions-only"])
    bench.main()
    d = json.loads(res.read_text())
    assert d["arms"] == {"A": 1} and d["definitions"] == bench.DEFINITIONS and res.read_text().endswith("}\n")
    assert capsys.readouterr().out == f"definitions rewritten in {res} (numbers untouched)\n"


def test_main_needs_token_and_base(monkeypatch):
    monkeypatch.delenv("BENCH_TOKEN", raising=False)
    monkeypatch.setattr("sys.argv", ["bench.py", "--base", "http://b"])
    with pytest.raises(SystemExit, match="BENCH_TOKEN is not set"):
        bench.main()
    monkeypatch.setattr("sys.argv", ["bench.py"])
    with pytest.raises(SystemExit) as e:
        bench.main()
    assert e.value.code == 2


class FakeLive:
    """Stand-in for bench.Http: a tiny deployment. Profile labels pick the behaviour."""

    def __init__(self, base, token):
        self.base, self.token = base, token

    def json(self, method, path, body=None, timeout=90):
        if path == "/api/cases":
            return (500, {"error": "boom"}) if body["label"] == "Ana" else (201, {"case": {"id": "case-" + body["label"]}})
        assert path == "/api/verify-venue"
        name = body["name"]
        if name == "Boom":
            return 500, {"error": "kaput"}
        return 200, {"verdict": verdict(verifiable=name != "Ghost", alcohol={"verdict": "REFUSE" if name == "Bar" else "OK"})}

    def sse_plan(self, path, body=None, timeout=120):
        label = path.split("/")[3][5:]
        p = plan(id=f"{label}-{body['bench']}", llm_model=None if label == "Theo" else "m1")
        if label == "Maya":
            p["empty_slots"].append({"day_name": "monday", "rung": "home", "reason": "x"})
        if label == "Cal":
            p["empty_slots"] = [{"day_name": "monday", "rung": "home", "reason": "x"}]
        return 200, p, {"tokens": {"llm_calls": 2, "input": 10, "output": 5, "unreported": 1}}, 10.0 + len(label)


@pytest.fixture
def live(tmp_path, monkeypatch):
    (tmp_path / "fixtures").mkdir()
    profiles = [profile("maya"), profile("theo", label="Theo", energy=2), profile("cal", label="Cal", in_recovery=True, energy=3), profile("ana", label="Ana")]
    (tmp_path / "fixtures" / "profiles.json").write_text(json.dumps({"profiles": profiles}))
    monkeypatch.setattr(bench, "ROOT", str(tmp_path))
    monkeypatch.setattr(bench, "Http", FakeLive)
    guard = []
    monkeypatch.setattr(bench, "require_redis", guard.append)
    monkeypatch.setenv("BENCH_TOKEN", "TOK")
    llm_calls = []

    def llm_plan(prompt):
        llm_calls.append(prompt)
        if "Williamsburg" in prompt and "Energy: medium" in prompt:   # theo
            raise RuntimeError("LLM failed: x")
        return [{"day": "tuesday", "hour": "17", "kind": "outing", "venue_name": "Open Cafe", "street_address": "1 Main St"}], 2.5, "qwen-x", {"llm_calls": 1, "input": 3, "output": 4, "unreported": 0}

    monkeypatch.setattr(bench, "llm_plan", llm_plan)
    return SimpleNamespace(root=tmp_path, guard=guard, llm_calls=llm_calls)


def run_main(monkeypatch, out, *args):
    monkeypatch.setattr("sys.argv", ["bench.py", "--base", "http://dep/", "--out", str(out), "--workers", "1", *args])
    bench.main()
    return json.loads(out.read_text())


def test_main_full_run(live, monkeypatch, capsys):
    out = live.root / "nested" / "dir" / "results.json"
    d = run_main(monkeypatch, out)
    assert live.guard == ["http://dep/"]
    assert out.read_text().endswith("}\n")
    assert d["generated_by"] == "scripts/bench.py" and d["base"] == "http://dep/" and d["profiles"] == 4 and d["in_recovery_profiles"] == 2
    assert d["definitions"] == bench.DEFINITIONS and d["model_arm_a"] == "qwen3.8-flash (enable_thinking=false, temperature 0.2)"
    # jobs: B for all 4 profiles, B-/B-4 for the two in recovery (maya is forced), ana fails at case creation
    assert sorted((p["profile"], p["arm"]) for p in d["plans"]) == sorted([("maya", a) for a in ("B", "B-", "B-4")] + [("cal", a) for a in ("B", "B-", "B-4")] + [("theo", "B")])
    assert d["errors"] == [{"profile": "ana", "arm": "B", "error": "case 500: {'error': 'boom'}"}, {"profile": "theo", "arm": "A", "error": "LLM failed: x"}]
    assert len(d["arm_a_runs"]) == 3 and len(live.llm_calls) == 4
    assert set(d["arms"]) == {"A", "B", "B-", "B-4", "B-sym"}
    assert d["arms"]["B"]["outing_venues"] == 6 and d["arms"]["A"]["outing_venues"] == 3 and d["arms"]["B-sym"]["unverifiable"] == 3
    assert d["arms"]["B-"]["outing_venues"] == 4
    ab = d["ablation_in_recovery"]
    assert set(ab) == {"B", "B-", "B-4"} and ab["B"]["profiles"] == 2
    assert ab["B"] == {"profiles": 2, "pool_candidates": 60, "pool_alcohol": 2, "pool_alcohol_rate": 0.0333, "profiles_with_pool_alcohol": 2,
                       "pool_alcohol_review": 2, "outing_cards": 4, "plan_alcohol_leak": 2, "plan_alcohol_leak_rate": 0.5, "profiles_with_plan_leak": 2}
    lat = d["latency"]
    assert lat["B"] == {"plans": 3, "client_p50_s": 14.0, "client_p95_s": 14.0, "server_p50_s": 21.0, "server_p95_s": 21.0, "qloo_calls_mean": 9, "qloo_calls_p50": 9}
    assert lat["A"] == {"plans": 3, "llm_p50_s": 2.5, "llm_p95_s": 2.5}
    thin = [{"day": "saturday", "rung": "solo", "reason": "thin"}]
    assert d["coverage_refusals_arm_b"] == [{"profile": "maya", "empty_outings": thin}, {"profile": "theo", "empty_outings": thin}]  # cal's only empty slot is at-home
    assert d["tokens"] == {"llm_calls": 3 * 1 + 7 * 2, "input": 3 * 3 + 7 * 10, "output": 3 * 4 + 7 * 5, "unreported": 7}
    assert d["verify_venue_calls"] > 0 and len(d["venues"]) == d["arms"]["A"]["outing_venues"] + sum(d["arms"][k]["outing_venues"] + d["arms"][k]["errors"] for k in ("B", "B-", "B-4"))
    text = capsys.readouterr().out
    assert text.startswith("rekindle runs: 8 (B, B-, B-4) · workers 1")
    assert "  B    ana    ERROR case 500" in text and "  graded B    maya" in text and "  arm A maya" in text
    assert "KILLER NUMBER (Qloo-graded)" in text and "ABLATION (in-recovery profiles)" in text and "LATENCY {" in text and f"errors: 2 · wrote {out}" in text


def test_main_subset_without_symmetry_or_arm_a(live, monkeypatch, capsys):
    out = live.root / "o.json"
    d = run_main(monkeypatch, out, "--only", "maya,theo", "--arms", "B,B-4", "--no-symmetry")
    assert [(p["profile"], p["arm"]) for p in d["plans"]] == [("maya", "B"), ("maya", "B-4"), ("theo", "B")]
    assert set(d["arms"]) == {"B", "B-4"} and d["symmetry_venues"] == [] and d["arm_a_runs"] == []
    assert set(d["ablation_in_recovery"]) == {"B", "B-4"} and set(d["latency"]) == {"B", "B-4"}
    assert d["errors"] == [] and live.llm_calls == [] and d["profiles"] == 2
    assert d["tokens"]["llm_calls"] == 6


def test_main_handles_a_run_with_no_plans(live, monkeypatch):
    out = live.root / "o.json"
    d = run_main(monkeypatch, out, "--only", "ana", "--arms", "B,B-")
    assert d["plans"] == [] and [e["profile"] for e in d["errors"]] == ["ana"]
    assert d["arms"] == {"B": bench.summarise([]), "B-": bench.summarise([])}
    assert d["ablation_in_recovery"]["B"]["profiles"] == 0 and d["ablation_in_recovery"]["B"]["pool_alcohol_rate"] is None and d["ablation_in_recovery"]["B"]["plan_alcohol_leak_rate"] is None
    assert d["latency"]["B"]["client_p50_s"] is None and d["latency"]["B"]["qloo_calls_mean"] is None


def test_main_default_out_is_bench_results(live, monkeypatch):
    (live.root / "bench").mkdir()
    monkeypatch.setattr("sys.argv", ["bench.py", "--base", "http://dep", "--only", "nobody", "--arms", "B"])
    bench.main()
    assert json.loads((live.root / "bench" / "results.json").read_text())["profiles"] == 0
