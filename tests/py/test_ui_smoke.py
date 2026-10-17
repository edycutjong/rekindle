import itertools
import sys
from types import SimpleNamespace

import pytest
from conftest import run_script

import fakepw

BASE = "https://dep.example"
ALERTS = "[...document.querySelectorAll('[role=alert]')].map((n) => n.innerText).join(' ')"
ALERT_EXPR = f"() => {ALERTS}"
LEAVING = "[data-testid=replan-summary] .leaving-out li, [data-testid=replan-summary] li"
GATES = [
    "week 1: 7 cards, every card has a why line", "reload shows the same week", "swap re-ran one slot", "approve week stamps every card",
    "re-plan disabled < 3 rated, enabled at 3", "week 2 re-planned with a diff", "ember underline on the >= 7 activities",
    "ember threads only where a rating leads the loves (one per card)", "ember 'because of' only on a lead >= 0.02", "week 2 survives a reload",
    "week 1 locked and links to week 2", "patient sheet prints the approved week only, without weights or rule IDs", "no horizontal scroll at 375 px",
    "header is at most two rows at 375 px", "no console errors", "in recovery: no coaching line mentions drinking (COACH-ALC)",
    "the card the clinician swapped out is not in week 2", "rated >=7 is kept or listed as a signal, never under 'Leaving out'",
]


def world(**over):
    toggle = iter([False, True])
    w = fakepw.World(
        counts={
            "[data-testid=slot-card]": 7, "[data-testid=why]": 7, "[data-testid=struck]": 1, "[data-testid=hours]": 7,
            "[data-testid=struck][data-rule=R-ALC]": 1, "[data-testid=struck][data-rule=CLINICIAN]": 1,
            "[data-testid=slot-card][data-approved=true]": 7, "[data-testid=rekindled]": 2, "[data-testid=ember-threads] path": 2,
            "[data-testid=replan-diff]": 1, "[data-testid=next-week]": 1, "[data-testid=pm-locked]": 2, "[data-testid=print-row]": 7,
            "[data-testid=ember-label]": 2, "tbody tr": 12,
        },
        texts={"h3": "Old Cafe", "[data-testid=toggle-notice]": "Swapped Old Cafe", "[data-testid=stamp]": "Approved by Dr Test", "[data-testid=rated-count]": " 3 of 7 ",
               "h1": "Week 2 for Maya", "[data-testid=print-sheet]": "Monday 7pm Ramen\nTuesday 5pm Walk"},
        lists={"[data-testid=coach]": ["Take a walk"], "[data-testid=slot-card] h3": ["Alpha", "Bravo", "Charlie"],
               "[data-testid=ember-label]": ["because of Phoebe +0.031 over your loves", "because of Fleabag +0.025"], "[data-testid=ember-tied]": ["tied with ramen"],
               "[data-testid=kept-note]": ["kept"], "[data-testid=kept-label]": ["Kept for you"], "[data-testid=signal-list] li": ["Phoebe >=7"], LEAVING: []},
        enabled={"[data-testid=replan]": lambda: next(toggle)},
        evaluate={ALERT_EXPR: "", "document.documentElement.scrollWidth": 375, "document.querySelector('header').getBoundingClientRect().height": 96},
    )
    for table, vals in over.items():
        getattr(w, table).update(vals)
    return w


@pytest.fixture
def env(monkeypatch, health_ok):
    monkeypatch.setattr("time.sleep", lambda s: None)
    monkeypatch.delenv("REKINDLE_JUDGE_TOKEN", raising=False)
    return monkeypatch


def run(env, w, *extra):
    fakepw.install(env, w)
    code = run_script("ui_smoke", [BASE, "/shots", *extra], env)
    return code


def results(capsys):
    out = capsys.readouterr().out
    res, lines = fakepw.parse_run(out)
    return res, lines, out


def verdicts(lines):
    return {l[5:]: l.startswith("PASS") for l in lines if l.startswith(("PASS ", "FAIL "))}


def set_url(env):
    """pg.url must look like a deployment URL once the app has navigated (the script reads plan ids off it)."""
    orig = fakepw.Page.goto

    def goto(self, url, **k):
        orig(self, url, **k)
        self.url = url if "/plans/" in url else BASE + "/plans/abc123"

    env.setattr(fakepw.Page, "goto", goto)
    env.setattr(fakepw.Page, "reload", lambda self, **k: self.w.log.append(("reload", self.url, k)))


def test_healthy_deployment_passes_every_gate(env, capsys):
    w = world()
    set_url(env)
    assert run(env, w, "ci") == 0
    res, lines, out = results(capsys)
    v = verdicts(lines)
    assert list(v) == GATES and all(v.values())
    assert (res["cards"], res["why"], res["struck"], res["hours"], res["alc_struck"], res["clinician_strikes"]) == (7, 7, 1, 7, 1, 1)
    assert res["toggle_notice"] == "Swapped Old Cafe" and res["swapped_out"] == "Old Cafe" and res["swap_changed"] is True
    assert res["stamp"] == "Approved by Dr Test" and res["approved_cards"] == 7 and res["rated_count"] == "3 of 7"
    assert res["replan_enabled_before"] is False and res["replan_enabled_after"] is True
    assert res["rated_names"] == {"Old Cafe": 2}  # the three rated cards share one fake title; the last (index n-1, P=2) wins
    assert res["week2_heading"] == "Week 2 for Maya" and res["week2_cards"] == 7 and res["print_rows"] == 7 and res["print_alcohol"] is False
    assert res["print_has_weights_or_rules"] is False and res["print_button_hidden_in_print"] is True
    assert res["mobile_scroll_width"] == res["mobile_replan_scroll_width"] == res["mobile_home_scroll_width"] == 375 and res["mobile_header_height"] == 96
    assert res["receipts_rows"] == 12 and res["console_errors"] == [] and res["coach_alcohol_after_recovery"] == []
    assert res["plan_url"] == BASE + "/plans/abc123" and "plan_seconds_from_click" in res and "swap_seconds" in res and "replan_seconds_from_click" in res
    assert w.closed
    shots = [e[1] for e in w.calls("screenshot")]
    assert shots[0] == "/shots/ci-home-1440.png" and "/shots/ci-print-375.png" in shots and shots[-1] == "/shots/ci-receipts-1440.png"
    assert len(shots) == 14


def test_default_tag_and_navigation_order(env, capsys):
    w = world()
    set_url(env)
    run(env, w)
    assert w.calls("screenshot")[0][1] == "/shots/local-home-1440.png"
    gotos = [e[1] for e in w.calls("goto")]
    assert gotos[0] == BASE + "/" and gotos[-2:] == [BASE + "/integrations/qloo?plan=abc123", BASE + "/integrations/qloo"]
    assert BASE + "/integrations/qloo?plan=abc123" in gotos
    assert w.calls("emulate_media") == [("emulate_media", {"media": "print"}), ("emulate_media", {"media": "screen"})]
    fills = [(e[1], e[2][0]) for e in w.calls("loc.fill")]
    assert fills == [(f"[data-testid=slot-card]#{i} >> [data-testid=rate-{k}]", str(val)) for i, (p, m) in zip((0, 1, 6), ((8, 5), (9, 6), (2, 3))) for k, val in (("p", p), ("m", m))]
    capsys.readouterr()


def test_judge_token_is_applied_first(env, capsys):
    env.setenv("REKINDLE_JUDGE_TOKEN", "TOK123")
    w = world()
    set_url(env)
    run(env, w)
    assert [e[1] for e in w.calls("goto")][:2] == [BASE + "/?judge=TOK123", BASE + "/"]
    capsys.readouterr()


def test_without_token_the_first_visit_is_the_home_page(env, capsys):
    w = world()
    set_url(env)
    run(env, w)
    assert not any("judge=" in e[1] for e in w.calls("goto"))
    capsys.readouterr()


@pytest.mark.parametrize(
    "step_index,step,message",
    [
        (1, "Maya's case (its week-1 plan starts on arrival)", "Capacity   reached\nfor today"),
        (2, "planning week 1", "Too many requests, slow down"),
        (3, "the In recovery toggle", "capacity reached"),
        (4, "the swap", "TOO MANY REQUESTS"),
        (5, "the week-2 re-plan", "Capacity reached"),
    ],
)
def test_rate_limit_exits_3_naming_the_step(env, capsys, step_index, step, message):
    calls = itertools.count(1)
    alert = lambda: message if next(calls) == step_index else ""
    w = world(evaluate={ALERT_EXPR: alert})
    set_url(env)
    assert run(env, w) == 3
    out = capsys.readouterr().out
    text = " ".join(message.split())
    assert f"CAPPED at {step}: {text}" in out
    assert "not a failed gate" in out and "x-ratelimit-*" in out
    assert not w.closed                                # exited mid-run, before the summary
    assert "PASS " not in out and "FAIL " not in out


def test_alert_text_that_is_not_a_limit_does_not_cap(env, capsys):
    w = world(evaluate={ALERT_EXPR: "Something went wrong"})
    set_url(env)
    assert run(env, w) == 0
    capsys.readouterr()


def test_wait_for_function_waits_on_alerts_or_the_condition(env, capsys):
    w = world()
    set_url(env)
    run(env, w)
    exprs = [e[1] for e in w.calls("wait_for_function")]
    assert exprs[0] == f"() => /capacity reached|too many requests/i.test({ALERTS}) || (location.pathname.includes('/cases/'))"
    assert any("toggle-notice" in e and "Swapped|No other verified" in e for e in exprs)
    capsys.readouterr()


# each override breaks exactly the named gates
SEQ = lambda *vals: (lambda it=iter(vals), last=[None]: last.__setitem__(0, next(it, last[0])) or last[0])


@pytest.mark.parametrize(
    "over,failing",
    [
        ({"counts": {"[data-testid=why]": 6}}, [GATES[0]]),
        ({"lists": {"[data-testid=slot-card] h3": SEQ(["A", "B"], ["A", "B", "C"], ["Alpha"])}}, [GATES[1]]),
        ({"lists": {"[data-testid=slot-card] h3": ["Old Cafe", "B"]}}, [GATES[2], GATES[16]]),
        ({"texts": {"[data-testid=stamp]": "Pending"}}, [GATES[3]]),
        ({"counts": {"[data-testid=slot-card][data-approved=true]": 3}}, [GATES[3]]),
        ({"enabled": {"[data-testid=replan]": True}}, [GATES[4]]),
        ({"enabled": {"[data-testid=replan]": False}}, [GATES[4]]),
        ({"texts": {"h1": "Week 1 for Maya"}}, [GATES[5]]),
        ({"counts": {"[data-testid=rekindled]": 3}}, [GATES[6]]),
        ({"counts": {"[data-testid=ember-threads] path": 1}}, [GATES[7]]),
        ({"lists": {"[data-testid=ember-label]": ["because of X +0.010"]}, "counts": {"[data-testid=ember-threads] path": 1}}, [GATES[8]]),
        ({"lists": {"[data-testid=ember-label]": ["no number here"]}, "counts": {"[data-testid=ember-threads] path": 1}}, [GATES[8]]),
        ({"lists": {"[data-testid=ember-tied]": ["because of tied thing"]}}, [GATES[8]]),
        ({"counts": {"[data-testid=replan-diff]": 2}}, [GATES[9]]),
        ({"counts": {"[data-testid=next-week]": 0}}, [GATES[10]]),
        ({"counts": {"[data-testid=pm-locked]": 0}}, [GATES[10]]),
        ({"counts": {"[data-testid=print-row]": 6}}, [GATES[11]]),
        ({"texts": {"[data-testid=print-sheet]": "Ramen because it is warm"}}, [GATES[11]]),
        ({"texts": {"[data-testid=print-sheet]": "score 0.42"}}, [GATES[11]]),
        ({"texts": {"[data-testid=print-sheet]": "blocked by R-ALC"}}, [GATES[11]]),
        ({"visible": {"[data-testid=print-button]": True}}, [GATES[11]]),
        ({"evaluate": {"document.documentElement.scrollWidth": 376}}, [GATES[12]]),
        ({"evaluate": {"document.querySelector('header').getBoundingClientRect().height": 113}}, [GATES[13]]),
        ({"lists": {"[data-testid=coach]": ["Skip the bar", "Have a drink"]}}, [GATES[15]]),
        ({"lists": {LEAVING: ["Phoebe ≥7 rated"]}}, [GATES[17]]),
        ({"lists": {LEAVING: ["Phoebe ≥7 rated"], "[data-testid=signal-list] li": ["Phoebe ≥7 rated"]}}, []),
        ({"lists": {"[data-testid=kept-label]": [], "[data-testid=signal-list] li": []}}, [GATES[17]]),
    ],
)
def test_one_broken_behaviour_fails_its_gate(env, capsys, over, failing):
    w = world(**over)
    set_url(env)
    code = run(env, w)
    _, lines, _ = results(capsys)
    v = verdicts(lines)
    assert [g for g, ok in v.items() if not ok] == failing
    assert code == (1 if failing else 0)


def test_print_gate_reports_alcohol_in_the_patient_sheet(env, capsys):
    w = world(texts={"[data-testid=print-sheet]": "Monday: a cocktail at the bar"})
    set_url(env)
    run(env, w)
    res, lines, _ = results(capsys)
    assert res["print_alcohol"] is True
    assert all(verdicts(lines).values())          # the print gate does not look at alcohol; COACH-ALC does, on the coaching lines


def test_console_and_page_errors_are_collected(env, capsys):
    w = world()
    set_url(env)
    orig = fakepw.Page.goto
    fired = []

    def goto(self, url, **k):
        orig(self, url, **k)
        if not fired and {"console", "pageerror"} <= set(self.handlers):
            fired.append(1)
            self.handlers["console"](SimpleNamespace(type="log", text="hello"))
            self.handlers["console"](SimpleNamespace(type="error", text="bad request"))
            self.handlers["pageerror"](RuntimeError("uncaught"))
        self.url = url if "/plans/" in url else BASE + "/plans/abc123"

    env.setattr(fakepw.Page, "goto", goto)
    assert run(env, w) == 1
    res, lines, _ = results(capsys)
    assert res["console_errors"] == ["bad request", "uncaught"] and verdicts(lines)["no console errors"] is False


def test_guard_runs_before_playwright_is_imported(env):
    import store_guard
    env.setattr(store_guard, "require_redis", lambda base: sys.exit("refusing: blob"))
    env.delitem(sys.modules, "playwright", raising=False)
    env.delitem(sys.modules, "playwright.sync_api", raising=False)
    assert run_script("ui_smoke", [BASE, "/s"], env) == "refusing: blob"
    assert "playwright" not in sys.modules
