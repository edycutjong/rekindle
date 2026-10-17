import json
import sys

import pytest
from conftest import run_script

import fakepw

BASE = "https://dep.example/"


def world(**over):
    w = fakepw.World(
        counts={"[data-testid=new-case]": 1, "[data-testid=slot-card]": 5, "[data-testid=empty-slot]": 1, "[data-testid=qloo-unavailable]": 1,
                "header": 1, "[data-testid=nf-home]": 1, "[data-testid=nf-judge]": 1},
        texts={"[data-testid=love-chip]#0": "Chip", "h1": "Rosa's week"},
        disabled={"[data-testid=intake-submit]": True}, enabled={"[data-testid=intake-submit]": True},
        evaluate={"document.documentElement.scrollWidth": 375},
    )
    for table, vals in over.items():
        getattr(w, table).update(vals)
    return w


@pytest.fixture
def env(monkeypatch, health_ok):
    monkeypatch.setattr("time.sleep", lambda s: None)
    return monkeypatch


def go(env, w, *extra):
    fakepw.install(env, w)
    return w


def parse(capsys):
    out = capsys.readouterr().out
    return fakepw.parse_run(out)[0], out


def test_all_gates_pass(env, capsys):
    w = go(env, world())
    assert run_script("intake_smoke", [BASE, "/shots", "ci"], env) == 0
    res, out = parse(capsys)
    assert res["picked"] == ["Chip", "Chip", "Chip"] and res["slots"] == 7 and res["cards"] == 5
    assert res["case_strip"] == "Rosa's week" and res["intake_375_scroll_width"] == 375 and res["nf_title"] == "Rosa's week"
    assert res["page_errors"] == [] and isinstance(res["plan_seconds_from_save"], float)
    assert res["gates"] == {"home_links_intake": True, "submit_disabled_until_ready": True, "submit_enabled_with_3_confirmed": True,
                            "intake_case_plans_live": True, "not_found_has_header_and_links": True, "intake_375_no_scroll": True, "no_page_errors": True}
    assert "FAIL" not in out and out.count("PASS ") == 7
    shots = [e[1] for e in w.calls("screenshot")]
    assert shots == [f"/shots/ci-{n}.png" for n in ("intake-1440", "intake-week1-1440", "404-1440", "intake-375")]
    assert w.closed and w.contexts[0]["viewport"] == {"width": 1440, "height": 1000} and w.contexts[1]["is_mobile"] is True
    gotos = [e[1] for e in w.calls("goto")]
    assert gotos == ["https://dep.example/", "https://dep.example/plans/00000000-0000-0000-0000-000000000000", "https://dep.example/cases/new"]


def test_each_love_is_typed_into_its_row_and_confirmed(env, capsys):
    w = go(env, world())
    run_script("intake_smoke", [BASE, "/s"], env)
    fills = [(e[1], e[2][0]) for e in w.calls("loc.fill") if "intake-love-text" in e[1]]
    assert [f[1] for f in fills] == ["Phoebe Bridgers", "Fleabag", "ramen"]
    kinds = [e[2][0] for e in w.calls("loc.select_option")]
    assert kinds == ["artist", "tv_show", "place_tag"]
    assert [e[1] for e in w.calls("loc.click")].count("[data-testid=intake-love]#2 >> [data-testid=love-chip]#0") == 1
    assert w.calls("select_option")[0][1] == "[data-testid=intake-point]"
    assert ("fill", "[data-testid=intake-label]", "Rosa", {}) in w.log
    capsys.readouterr()


def test_default_tag_is_local(env, capsys):
    w = go(env, world())
    run_script("intake_smoke", [BASE, "/s"], env)
    assert w.calls("screenshot")[0][1] == "/s/local-intake-1440.png"
    capsys.readouterr()


@pytest.mark.parametrize(
    "over,failing",
    [
        ({"counts": {"[data-testid=new-case]": 0}}, ["home_links_intake"]),
        ({"disabled": {"[data-testid=intake-submit]": False}}, ["submit_disabled_until_ready"]),
        ({"enabled": {"[data-testid=intake-submit]": False}}, ["submit_enabled_with_3_confirmed"]),
        ({"counts": {"[data-testid=slot-card]": 3}}, ["intake_case_plans_live"]),          # 3 + 1 + 1 = 5 slots
        ({"counts": {"[data-testid=empty-slot]": 4, "[data-testid=slot-card]": 3}}, ["intake_case_plans_live"]),  # 7 slots but only 3 cards
        ({"counts": {"[data-testid=nf-judge]": 0}}, ["not_found_has_header_and_links"]),
        ({"evaluate": {"document.documentElement.scrollWidth": 400}}, ["intake_375_no_scroll"]),
    ],
)
def test_failed_gate_exits_1(env, capsys, over, failing):
    go(env, world(**over))
    assert run_script("intake_smoke", [BASE, "/s"], env) == 1
    res, out = parse(capsys)
    assert [k for k, v in res["gates"].items() if not v] == failing
    assert all(f"FAIL {k}" in out for k in failing)


def test_page_errors_fail_the_run(env, capsys):
    w = go(env, world())
    orig, fired = fakepw.Page.goto, []

    def goto(self, url, **k):
        orig(self, url, **k)
        if not fired and "pageerror" in self.handlers:  # the desktop page registered its handler; fire it once
            fired.append(1)
            self.handlers["pageerror"](RuntimeError("boom"))

    env.setattr(fakepw.Page, "goto", goto)
    assert run_script("intake_smoke", [BASE, "/s"], env) == 1
    res, _ = parse(capsys)
    assert res["page_errors"] == ["boom"] and res["gates"]["no_page_errors"] is False


def test_guard_runs_before_playwright_is_imported(env):
    import store_guard
    env.setattr(store_guard, "require_redis", lambda base: sys.exit("refusing: store is blob"))
    env.delitem(sys.modules, "playwright", raising=False)
    env.delitem(sys.modules, "playwright.sync_api", raising=False)
    assert run_script("intake_smoke", [BASE, "/s"], env) == "refusing: store is blob"
    assert "playwright" not in sys.modules
