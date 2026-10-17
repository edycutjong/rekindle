import sys

import pytest
from conftest import run_script

import fakepw

BASE = "https://dep.example/"
NOTICE = "toggle-notice"


def world(**over):
    w = fakepw.World(
        counts={
            "[data-testid=edge-states] > li": 6, "[data-testid=bench-table] tbody tr": 5,
            "[data-testid=skeleton]": 3, "[data-testid=struck]": 2, "[data-testid=review]": 1,
            "[data-testid=empty-slot]": 2, "[data-testid=coverage-refusal]": 1, "[data-testid=widen-radius]": 1,
            "[data-testid=coverage-binding]": 1, "[data-testid^=relax-]": 2,
            "[data-testid=outage-banner]": 1, "[data-testid=qloo-unavailable]": 4,
        },
        texts={
            "[data-testid=coverage-refusal]": "Not enough verified places " * 20,
            "[data-testid=coverage-binding]": "quiet is binding",
            "[data-testid^=relax-]#0": "Drop quiet", "[data-testid^=relax-]#1": "Drop wheelchair",
            "[data-testid=toggle-notice]": "Retried 2 empty outings within 4.5 km: 1 filled",
        },
        lists={"[data-testid=coach]": ["Take a short walk", "Call a friend"]},
        evaluate={"document.documentElement.scrollWidth": 375},
    )
    for table, vals in over.items():
        getattr(w, table).update(vals)
    return w


@pytest.fixture
def env(monkeypatch, health_ok):
    monkeypatch.setattr("time.sleep", lambda s: None)
    return monkeypatch


def run(env, w, tag=None):
    fakepw.install(env, w)
    return run_script("edge_states", [BASE, "/shots", *([tag] if tag else [])], env)


def gates_of(capsys):
    res, lines = fakepw.parse_run(capsys.readouterr().out)
    return res, res["gates"], lines


ALL_GATES = ["loading", "refused", "review_button_shows_review", "review_button_coaching_alcohol_free", "review", "empty", "coverage_refusal",
             "coverage_names_binding_filter", "relax_fills_an_outing", "widen_notice_reports_retry", "qloo_unavailable", "outage_fills_nothing",
             "judge_375_no_scroll", "no_page_errors"]


def test_every_state_passes_on_a_healthy_deployment(env, capsys):
    w = world()
    assert run(env, w, "ci") == 0
    res, gates, lines = gates_of(capsys)
    assert list(gates) == ALL_GATES and all(gates.values()) and lines == ["PASS " + g for g in ALL_GATES]
    assert (res["judge_states_listed"], res["judge_bench_table_rows"], res["maya_struck"], res["maya_review"], res["review_button_boxes"]) == (6, 5, 2, 1, 1)
    assert res["review_shown_on"] == "maya in recovery (REVIEW button)" and res["review_button_coaching_alc"] == []
    assert res["cal_empty"] == 2 and len(res["coverage_text"]) == 300 and res["coverage_binding"] == "quiet is binding"
    assert res["relax_buttons"] == ["Drop quiet", "Drop wheelchair"] and res["relax_notice"] == res["widen_notice"]
    assert res["outage_slots"] == 4 and res["outage_cards"] == 0 and res["judge_375_scroll_width"] == 375 and res["page_errors"] == []
    assert w.closed
    shots = [e[1] for e in w.calls("screenshot")]
    assert shots[0] == "/shots/ci-judge-1440.png" and shots[-1] == "/shots/ci-judge-375.png"
    assert [s.split("ci-")[1] for s in shots[1:-1]] == [f"state-{n}-1440.png" for n in ("loading", "refused", "review", "coverage", "relaxed", "widened", "outage")]
    clicks = [e[1] for e in w.calls("click")]
    assert clicks == [f"[data-testid={t}]" for t in ("start-maya", "start-maya-recovery", "start-cal", "widen-radius", "start-maya-outage")]
    assert [e[1] for e in w.calls("loc.click")] == ["[data-testid^=relax-]#0"]
    assert [e[1] for e in w.calls("loc.scroll")] == ["[data-testid=review]#0"]


def test_default_tag_is_local(env, capsys):
    w = world()
    run(env, w)
    assert w.calls("screenshot")[0][1] == "/shots/local-judge-1440.png"


def test_each_state_starts_from_judge_and_waits_for_the_plan(env, capsys):
    w = world()
    run(env, w)
    gotos = [e[1] for e in w.calls("goto")]
    assert gotos.count("https://dep.example/judge") == 6   # the first visit, 4 starts, and the mobile visit
    assert gotos[-1] == "https://dep.example/judge"
    urls = [e[1] for e in w.calls("wait_for_url")]
    assert urls.count("**/cases/**") == 4 and urls.count("**/plans/**") == 4


def test_no_review_box_and_nothing_to_relax(env, capsys):
    w = world(counts={"[data-testid=review]": 0, "[data-testid=coverage-refusal]": 0, "[data-testid=coverage-binding]": 0, "[data-testid^=relax-]": 0})
    assert run(env, w) == 1
    res, gates, _ = gates_of(capsys)
    assert [k for k, v in gates.items() if not v] == ["review_button_shows_review", "review", "coverage_refusal", "coverage_names_binding_filter"]
    assert res["review_shown_on"] is None and res["coverage_text"] is None and res["coverage_binding"] is None and res["relax_buttons"] == []
    assert "relax_fills_an_outing" not in gates and "widen_notice_reports_retry" in gates      # widen still offered, relax not
    assert not any("state-review" in (e[1] or "") for e in w.calls("screenshot"))
    assert not any("state-relaxed" in (e[1] or "") for e in w.calls("screenshot"))


def test_relax_without_widen(env, capsys):
    w = world(counts={"[data-testid=widen-radius]": 0}, texts={"[data-testid=toggle-notice]": "Retried 3 empty outings (quiet off): 2 filled"})
    assert run(env, w) == 0
    res, gates, _ = gates_of(capsys)
    assert gates["relax_fills_an_outing"] is True and "widen_notice_reports_retry" not in gates
    assert "widen_notice" not in res and res["widen_button"] == 0


def test_relax_that_fills_nothing_fails(env, capsys):
    w = world(texts={"[data-testid=toggle-notice]": "Retried 2 empty outings within 3 km: 0 filled"})
    assert run(env, w) == 1
    _, gates, _ = gates_of(capsys)
    assert gates["relax_fills_an_outing"] is False and gates["widen_notice_reports_retry"] is True


def test_relax_notice_that_is_not_a_retry_fails_both_checks(env, capsys):
    w = world(texts={"[data-testid=toggle-notice]": "Something else happened"})
    assert run(env, w) == 1
    _, gates, _ = gates_of(capsys)
    assert gates["relax_fills_an_outing"] is False and gates["widen_notice_reports_retry"] is False


def test_widen_only_when_relax_is_absent(env, capsys):
    w = world(counts={"[data-testid^=relax-]": 0})
    assert run(env, w) == 0
    res, gates, _ = gates_of(capsys)
    assert "relax_fills_an_outing" not in gates and gates["widen_notice_reports_retry"] is True and "relax_notice" not in res
    assert any("state-widened" in e[1] for e in w.calls("screenshot"))


@pytest.mark.parametrize(
    "over,failing",
    [
        ({"counts": {"[data-testid=skeleton]": 0}}, ["loading"]),
        ({"counts": {"[data-testid=struck]": 0}}, ["refused"]),
        ({"lists": {"[data-testid=coach]": ["Skip the bar tonight", "Have a drink"]}}, ["review_button_coaching_alcohol_free"]),
        ({"counts": {"[data-testid=empty-slot]": 0}}, ["empty"]),
        ({"counts": {"[data-testid=outage-banner]": 0}}, ["qloo_unavailable"]),
        ({"counts": {"[data-testid=qloo-unavailable]": 0}}, ["qloo_unavailable"]),
        ({"counts": {"[data-testid=slot-card]": 2}}, ["outage_fills_nothing"]),
        ({"evaluate": {"document.documentElement.scrollWidth": 376}}, ["judge_375_no_scroll"]),
    ],
)
def test_single_failed_state(env, capsys, over, failing):
    assert run(env, world(**over)) == 1
    res, gates, lines = gates_of(capsys)
    assert [k for k, v in gates.items() if not v] == failing
    assert all("FAIL " + f in lines for f in failing)


def test_coaching_regex_catches_every_alcohol_word(env, capsys):
    words = ["drink", "Drinks", "beer", "beers", "wine", "wines", "cocktail", "cocktails", "bar", "bars"]
    w = world(lists={"[data-testid=coach]": words + ["barbecue is fine", "wineries"]})
    run(env, w)
    res, _, _ = gates_of(capsys)
    assert res["review_button_coaching_alc"] == words


def test_page_errors_are_collected(env, capsys):
    w = world()
    orig, fired = fakepw.Page.goto, []

    def goto(self, url, **k):
        orig(self, url, **k)
        if not fired and "pageerror" in self.handlers:
            fired.append(1)
            self.handlers["pageerror"](ValueError("uncaught"))

    env.setattr(fakepw.Page, "goto", goto)
    assert run(env, w) == 1
    res, gates, _ = gates_of(capsys)
    assert res["page_errors"] == ["uncaught"] and gates["no_page_errors"] is False


def test_guard_runs_before_playwright_is_imported(env):
    import store_guard
    env.setattr(store_guard, "require_redis", lambda base: sys.exit("refusing: memory"))
    env.delitem(sys.modules, "playwright", raising=False)
    env.delitem(sys.modules, "playwright.sync_api", raising=False)
    assert run_script("edge_states", [BASE, "/s"], env) == "refusing: memory"
    assert "playwright" not in sys.modules
