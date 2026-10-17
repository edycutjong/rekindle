import json
import urllib.error
import urllib.parse

import pytest
from conftest import Resp, http_error

import seed


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(seed.time, "sleep", lambda s: None)


def fake_qloo(path, params, key, attempts=3):
    q = params.get("query") or params.get("filter.query")
    if path == "/search":
        return {"results": [{"entity_id": "E-" + q, "name": q.title()}]}
    return {"results": {"tags": [{"id": "urn:tag:genre:place:restaurant:" + q, "name": q}]}}


# ---------------------------------------------------------------- qloo_get

def test_qloo_get_builds_request_and_parses(monkeypatch):
    seen = {}

    def urlopen(req, timeout):
        seen.update(url=req.full_url, key=req.get_header("X-api-key"), ua=req.get_header("User-agent"), timeout=timeout)
        return Resp('{"ok": 1}')

    monkeypatch.setattr(seed.urllib.request, "urlopen", urlopen)
    assert seed.qloo_get("/search", {"query": "a b", "take": 3}, "KEY") == {"ok": 1}
    assert seen["url"] == "https://hackathon.api.qloo.com/search?query=a+b&take=3"
    assert (seen["key"], seen["ua"], seen["timeout"]) == ("KEY", "rekindle-seed/0.1", 15)


def test_qloo_get_retries_transient_errors(monkeypatch):
    outcomes = iter([http_error(429), urllib.error.URLError("dns"), Resp('{"v": 2}')])
    slept = []

    def urlopen(req, timeout):
        o = next(outcomes)
        if isinstance(o, Exception):
            raise o
        return o

    monkeypatch.setattr(seed.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(seed.time, "sleep", slept.append)
    assert seed.qloo_get("/x", {}, "k") == {"v": 2}
    assert slept == [1.0, 2.0]


@pytest.mark.parametrize("exc,calls", [(http_error(404), 1), (http_error(503), 3), (urllib.error.URLError("down"), 3)])
def test_qloo_get_gives_up(monkeypatch, exc, calls):
    n = []

    def urlopen(req, timeout):
        n.append(1)
        raise exc

    monkeypatch.setattr(seed.urllib.request, "urlopen", urlopen)
    with pytest.raises(type(exc)):
        seed.qloo_get("/x", {}, "k")
    assert len(n) == calls


def test_qloo_get_zero_attempts_returns_none(monkeypatch):
    assert seed.qloo_get("/x", {}, "k", attempts=0) is None


# ---------------------------------------------------------------- resolve helpers

@pytest.mark.parametrize(
    "tags,expected",
    [
        ([{"id": "urn:tag:genre:media:rock"}, {"id": "urn:tag:genre:place:restaurant:ramen"}, {"id": "urn:tag:x:place"}], "urn:tag:genre:place:restaurant:ramen"),
        ([{"id": "urn:tag:genre:media:rock"}, {"tag_id": "urn:tag:category:place"}], "urn:tag:category:place"),
        ([{"id": "urn:tag:a"}, {"id": "urn:tag:b"}], "urn:tag:a"),
        ([{"name": "no id"}, {"id": ""}], None),
        ([], None),
    ],
)
def test_pick_tag(tags, expected):
    assert seed.pick_tag(tags) == expected


def test_resolve_tag_uses_tag_name(monkeypatch):
    calls = []
    monkeypatch.setattr(seed, "qloo_get", lambda *a: calls.append(a) or {"results": {"tags": [{"id": "urn:tag:a", "name": "Tea"}, {"id": "urn:tag:b"}]}})
    assert seed.resolve("tea", "tea shop", "tag", "K") == {"text": "tea", "qloo_id": "urn:tag:a", "qloo_kind": "tag", "name": "Tea"}
    assert calls == [("/v2/tags", {"filter.query": "tea shop", "take": 20}, "K")]


@pytest.mark.parametrize("tags,name", [([{"tag_id": "urn:tag:z"}], "tea shop"), ([{"id": "urn:tag:z", "name": None}], "tea shop")])
def test_resolve_tag_falls_back_to_query_name(monkeypatch, tags, name):
    monkeypatch.setattr(seed, "qloo_get", lambda *a: {"results": {"tags": tags}})
    assert seed.resolve("tea", "tea shop", "tag", "K")["name"] == name


@pytest.mark.parametrize("body", [{}, {"results": None}, {"results": {"tags": []}}, {"results": {}}, {"results": {"tags": [{"name": "x"}]}}])
def test_resolve_tag_failure(monkeypatch, body):
    monkeypatch.setattr(seed, "qloo_get", lambda *a: body)
    with pytest.raises(SystemExit, match='FAIL: "tea" \\(query "tea shop"\\) did not resolve to a Qloo tag'):
        seed.resolve("tea", "tea shop", "tag", "K")


def test_resolve_entity(monkeypatch):
    calls = []
    monkeypatch.setattr(seed, "qloo_get", lambda *a: calls.append(a) or {"results": [{"entity_id": "E1", "name": "Fleabag"}, {"entity_id": "E2"}]})
    assert seed.resolve("Fleabag", "Fleabag", "tv_show", "K") == {"text": "Fleabag", "qloo_id": "E1", "qloo_kind": "entity", "entity_type": "urn:entity:tv_show", "name": "Fleabag"}
    assert calls == [("/search", {"query": "Fleabag", "types": "urn:entity:tv_show", "take": 3}, "K")]
    monkeypatch.setattr(seed, "qloo_get", lambda *a: {"results": [{"entity_id": "E9"}]})
    assert seed.resolve("x", "the query", "book", "K")["name"] == "the query"


@pytest.mark.parametrize("body", [{}, {"results": []}])
def test_resolve_entity_failure(monkeypatch, body):
    monkeypatch.setattr(seed, "qloo_get", lambda *a: body)
    with pytest.raises(SystemExit, match="did not resolve in Qloo as urn:entity:movie"):
        seed.resolve("x", "y", "movie", "K")


# ---------------------------------------------------------------- table / csv / check

def test_profile_table_invariants():
    assert len(seed.PROFILES) == 20 and len({p[0] for p in seed.PROFILES}) == 20
    assert all(len(p[9]) == 3 for p in seed.PROFILES)
    assert seed.RADIUS == {1: 1500, 2: 3000, 3: 5000}


def test_profile_record():
    r = seed.profile_record(seed.PROFILES[0], [{"x": 1}])
    assert r == {"slug": "maya", "label": "Maya", "locality": "Williamsburg, Brooklyn", "lon": -73.9571, "lat": 40.7081, "radius_m": 1500,
                 "energy": 1, "price_max": 2, "in_recovery": False, "need_quiet": False, "need_wheelchair": False, "loves": [{"x": 1}]}


def resolved_records(monkeypatch):
    monkeypatch.setattr(seed, "qloo_get", fake_qloo)
    return [seed.profile_record(p, [seed.resolve(t, q, k, "K") for t, q, k in p[9]]) for p in seed.PROFILES]


def test_to_csv(monkeypatch):
    recs = resolved_records(monkeypatch)
    text = seed.to_csv(recs)
    lines = text.splitlines()
    assert lines[0] == ",".join(seed.CSV_COLUMNS)
    assert len(lines) == 1 + 60
    assert lines[1] == 'Maya,POINT(-73.9571 40.7081),1500,1,2,false,false,false,Phoebe Bridgers,E-Phoebe Bridgers,entity,maya,"Williamsburg, Brooklyn",-73.9571,40.7081,urn:entity:artist,Phoebe Bridgers'
    assert lines[3] == 'Maya,POINT(-73.9571 40.7081),1500,1,2,false,false,false,ramen,urn:tag:genre:place:restaurant:ramen,tag,maya,"Williamsburg, Brooklyn",-73.9571,40.7081,,ramen'  # tag love: empty entity_type
    assert "\r" not in text


def write_fixtures(out, recs):
    out.mkdir(parents=True, exist_ok=True)
    (out / "profiles.json").write_text(json.dumps({"profiles": recs}))
    (out / "profiles.csv").write_text(seed.to_csv(recs))


def test_check_ok(monkeypatch, tmp_path, capsys):
    write_fixtures(tmp_path, resolved_records(monkeypatch))
    assert seed.check(str(tmp_path)) == 0
    out = capsys.readouterr().out
    assert "profiles 20 · loves 60 · in_recovery 9 (Maya toggled live) · quiet 6 · wheelchair 4 · OK" in out


def mutate(monkeypatch, tmp_path, fn):
    recs = resolved_records(monkeypatch)
    fn(recs)
    write_fixtures(tmp_path, recs)
    return seed.check(str(tmp_path))


@pytest.mark.parametrize(
    "fn,msg",
    [
        (lambda r: r.pop(), "FAIL expected 20 profiles, found 19"),
        (lambda r: r[0].update(radius_m=1), "FAIL maya: radius_m 1 != 1500"),
        (lambda r: r[1].update(in_recovery=False), "FAIL theo: in_recovery False != True"),
        (lambda r: r[2]["loves"][0].update(text="Other"), "FAIL ana: love texts differ"),
        (lambda r: r[3]["loves"][1].update(qloo_id=""), "FAIL sam: unresolved love Ursula K. Le Guin"),
    ],
)
def test_check_failures(monkeypatch, tmp_path, capsys, fn, msg):
    assert mutate(monkeypatch, tmp_path, fn) == 1
    out = capsys.readouterr().out
    assert msg in out and out.strip().endswith("FAILED")


def test_check_csv_drift(monkeypatch, tmp_path, capsys):
    write_fixtures(tmp_path, resolved_records(monkeypatch))
    (tmp_path / "profiles.csv").write_text("stale\n")
    assert seed.check(str(tmp_path)) == 1
    assert "FAIL profiles.csv is not the CSV form of profiles.json" in capsys.readouterr().out


def test_committed_fixtures_still_validate():
    """Read-only: the repo's own fixtures/ pass the offline check."""
    import pathlib
    assert seed.check(str(pathlib.Path(seed.__file__).resolve().parent.parent / "fixtures")) == 0


# ---------------------------------------------------------------- main

def test_main_check(monkeypatch, tmp_path, capsys):
    write_fixtures(tmp_path, resolved_records(monkeypatch))
    monkeypatch.setattr("sys.argv", ["seed.py", "--check", "--out", str(tmp_path)])
    assert seed.main() == 0


def test_main_default_out_is_repo_fixtures(monkeypatch):
    seen = {}
    monkeypatch.setattr(seed, "check", lambda out: seen.setdefault("out", out) and 0)
    monkeypatch.setattr("sys.argv", ["seed.py", "--check"])
    assert seed.main() == 0
    assert seen["out"].replace("\\", "/").endswith("scripts/../fixtures")


def test_main_without_flags_prints_help(monkeypatch, capsys):
    monkeypatch.setattr("sys.argv", ["seed.py"])
    assert seed.main() == 2
    assert "--resolve" in capsys.readouterr().out


def test_main_resolve_needs_key(monkeypatch):
    monkeypatch.delenv("QLOO_API_KEY", raising=False)
    monkeypatch.setattr("sys.argv", ["seed.py", "--resolve"])
    with pytest.raises(SystemExit, match="QLOO_API_KEY is not set"):
        seed.main()


def test_main_resolve_writes_fixtures_that_check(monkeypatch, tmp_path, capsys):
    monkeypatch.setenv("QLOO_API_KEY", "K")
    monkeypatch.setattr(seed, "qloo_get", fake_qloo)
    out = tmp_path / "fx"
    monkeypatch.setattr("sys.argv", ["seed.py", "--resolve", "--out", str(out)])
    assert seed.main() == 0
    stdout = capsys.readouterr().out
    assert "resolved 60 loves for 20 profiles with 60 Qloo calls" in stdout
    assert "Maya   Phoebe Bridgers → Phoebe Bridgers (E-Phoebe Bridgers)" in stdout
    data = json.loads((out / "profiles.json").read_text())
    assert data["fictional"] is True and len(data["profiles"]) == 20
    assert (out / "profiles.json").read_text().endswith("}\n")
    first = (out / "profiles.csv").read_bytes()
    assert seed.check(str(out)) == 0
    assert seed.main() == 0  # deterministic: a second run is byte-identical
    assert (out / "profiles.csv").read_bytes() == first
