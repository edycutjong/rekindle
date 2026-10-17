import csv
import json
import random
from types import SimpleNamespace

import pytest

import manual_audit as ma


@pytest.fixture
def proj(tmp_path, monkeypatch):
    root = tmp_path / "proj"
    (root / "bench").mkdir(parents=True)
    (root / "fixtures").mkdir()
    keydir = tmp_path / "assets" / "audit"
    monkeypatch.setattr(ma, "ROOT", str(root))
    monkeypatch.setattr(ma, "BENCH", str(root / "bench"))
    monkeypatch.setattr(ma, "CSV", str(root / "bench" / "manual_audit.csv"))
    monkeypatch.setattr(ma, "KEY", str(keydir / "manual_audit_key.csv"))
    (root / "fixtures" / "profiles.json").write_text(json.dumps({"profiles": [{"slug": "maya", "locality": "Williamsburg"}, {"slug": "theo", "locality": "Park Slope"}]}))
    return SimpleNamespace(root=root, keydir=keydir, bench=root / "bench", tmp=tmp_path)


def venue(arm, name, profile="maya", day="monday", hour=17, **kw):
    v = {"arm": arm, "name": name, "profile": profile, "day": day, "hour": hour, "in_recovery": False, "classes": {}, "verdict": {}}
    v.update(kw)
    return v


def write_results(proj, venues):
    (proj.bench / "results.json").write_text(json.dumps({"venues": venues}))


def read_csv(path):
    with open(path, newline="") as f:
        return list(csv.DictReader(f))


def sample_args(**kw):
    return SimpleNamespace(**{"n": 20, "seed": 1, "force": False, **kw})


SAMPLE_VENUES = [
    venue("A", "a1", stated_address="1 A St", in_recovery=True),
    venue("A", "a2", profile="theo", stated_address=None, hour=9),
    venue("A", "a3", classes={"error": True}),
    venue("A", ""),
    venue("B", "b1", address="2 B Ave"),
    venue("B", "b2", address=None, verdict={"match": {"address": "3 Match Rd"}}),
    venue("B", "b3", address=None, verdict={"match": None}),
    venue("B", "b4", address="", verdict=None),
]


# ---------------------------------------------------------------- sample

def test_sample_writes_blind_csv_and_key(proj, capsys):
    write_results(proj, SAMPLE_VENUES)
    ma.sample(sample_args())
    rows = read_csv(ma.CSV)
    key = {r["audit_id"]: r["arm"] for r in read_csv(ma.KEY)}
    assert [r["audit_id"] for r in rows] == [f"AUD-{i:02d}" for i in range(1, 7)]
    assert "arm" not in rows[0] and set(rows[0]) == set(ma.FIELDS)
    assert sorted(key.values()) == ["A", "A", "B", "B", "B", "B"]  # errors and nameless venues are not drawn
    by_name = {r["venue_name"]: r for r in rows}
    assert set(by_name) == {"a1", "a2", "b1", "b2", "b3", "b4"}
    assert by_name["a1"]["address"] == "1 A St" and by_name["a1"]["in_recovery"] == "yes" and by_name["a1"]["locality"] == "Williamsburg"
    assert by_name["a2"]["address"] == "" and by_name["a2"]["hour"] == "09:00" and by_name["a2"]["locality"] == "Park Slope"
    assert by_name["b1"]["address"] == "2 B Ave" and by_name["b2"]["address"] == "3 Match Rd" and by_name["b3"]["address"] == "" and by_name["b4"]["address"] == ""
    assert all(r["exists"] == r["open_at_slot"] == r["serves_alcohol"] == "" for r in rows)
    assert key[next(r["audit_id"] for r in rows if r["venue_name"] == "b2")] == "B"
    out = capsys.readouterr().out
    assert out.startswith("wrote 6 rows -> bench/manual_audit.csv (+ key ") and "manual_audit_key.csv)" in out


def test_sample_is_seeded_and_respects_n(proj):
    write_results(proj, [venue(arm, f"{arm}{i}", day="tuesday") for arm in "AB" for i in range(10)])
    ma.sample(sample_args(n=3, seed=7))
    first = read_csv(ma.CSV)
    assert len(first) == 6
    ma.sample(sample_args(n=3, seed=7))
    assert read_csv(ma.CSV) == first
    ma.sample(sample_args(n=3, seed=8))
    assert read_csv(ma.CSV) != first


def test_sample_refuses_to_overwrite_verdicts_unless_forced(proj):
    write_results(proj, SAMPLE_VENUES)
    ma.sample(sample_args())
    rows = read_csv(ma.CSV)
    rows[0]["exists"] = "yes"
    with open(ma.CSV, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=ma.FIELDS)
        w.writeheader()
        w.writerows(rows)
    with pytest.raises(SystemExit, match="already has verdicts; pass --force"):
        ma.sample(sample_args())
    assert read_csv(ma.CSV)[0]["exists"] == "yes"
    ma.sample(sample_args(force=True))
    assert read_csv(ma.CSV)[0]["exists"] == ""


def test_sample_redraws_an_unfilled_csv_without_force(proj):
    write_results(proj, SAMPLE_VENUES)
    ma.sample(sample_args())
    ma.sample(sample_args())  # no verdicts yet: allowed
    assert len(read_csv(ma.CSV)) == 6


# ---------------------------------------------------------------- verdict

@pytest.mark.parametrize(
    "row,wrong,checked,nf,closed,alc",
    [
        ({"exists": "no"}, True, True, True, False, False),
        ({"exists": "yes", "open_at_slot": "no"}, True, True, False, True, False),
        ({"exists": "yes", "open_at_slot": "yes", "in_recovery": "yes", "serves_alcohol": "yes"}, True, True, False, False, True),
        ({"exists": "yes", "open_at_slot": "yes", "in_recovery": "yes", "serves_alcohol": "no"}, False, True, False, False, False),
        ({"exists": "yes", "open_at_slot": "yes", "in_recovery": "yes", "serves_alcohol": "unknown"}, False, False, False, False, False),
        ({"exists": " YES ", "open_at_slot": "Yes", "in_recovery": "no", "serves_alcohol": "yes"}, False, True, False, False, False),
        ({"exists": "unclear", "open_at_slot": "yes"}, False, False, False, False, False),
        ({"exists": "yes", "open_at_slot": "unknown"}, False, False, False, False, False),
        ({}, False, False, False, False, False),
        ({"exists": None, "open_at_slot": None, "serves_alcohol": None}, False, False, False, False, False),
    ],
)
def test_verdict(row, wrong, checked, nf, closed, alc):
    assert ma.verdict(row) == {"wrong": wrong, "checked": checked, "not_found": nf, "closed": closed, "alcohol": alc}


# ---------------------------------------------------------------- handout

def filled_csv(path, rows):
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=ma.FIELDS)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in ma.FIELDS})


def test_handout_writes_outside_repo(proj, monkeypatch, capsys):
    filled_csv(ma.CSV, [{"audit_id": f"AUD-0{i}", "venue_name": f"v{i}", "address": f"{i} St", "locality": "L", "day": "monday", "hour": "17:00", "in_recovery": "no", "exists": "yes"} for i in (1, 2, 3)])

    class Reverse:
        def shuffle(self, xs):
            xs.reverse()

    monkeypatch.setattr(ma.random, "SystemRandom", Reverse)
    ma.handout(SimpleNamespace(out=""))
    hand = read_csv(proj.keydir / "external_audit_handout.csv")
    mapping = read_csv(proj.keydir / "external_audit_map.csv")
    assert [r["ext_id"] for r in hand] == ["EXT-01", "EXT-02", "EXT-03"]
    assert [r["venue_name"] for r in hand] == ["v3", "v2", "v1"]
    assert all(r["exists"] == "" for r in hand), "verdicts are never copied into the handout"
    assert "audit_id" not in hand[0]
    assert [(m["ext_id"], m["audit_id"]) for m in mapping] == [("EXT-01", "AUD-03"), ("EXT-02", "AUD-02"), ("EXT-03", "AUD-01")]
    out = capsys.readouterr().out
    assert "wrote 3 rows" in out and "Send ONLY the handout." in out and "recoverable from the public repo" in out


def test_handout_custom_out_and_repo_refusal(proj, monkeypatch):
    filled_csv(ma.CSV, [{"audit_id": "AUD-01", "venue_name": "v"}])
    dest = proj.tmp / "elsewhere"
    ma.handout(SimpleNamespace(out=str(dest)))
    assert (dest / "external_audit_handout.csv").exists()
    for inside in (str(proj.root / "bench"), str(proj.root)):
        with pytest.raises(SystemExit, match="outside the repo"):
            ma.handout(SimpleNamespace(out=inside))


# ---------------------------------------------------------------- oracle

@pytest.mark.parametrize(
    "v,expected",
    [
        ({"classes": {"unverifiable": True, "closed_at_slot": True}}, "unverifiable"),
        ({"classes": {"closed_at_slot": True, "alcohol": True}}, "closed_at_slot"),
        ({"classes": {"alcohol": True}}, "alcohol"),
        ({"classes": {"unknown_hours": True}}, "pass"),
        ({"classes": None}, "pass"),
        ({}, "pass"),
    ],
)
def test_oracle_class(v, expected):
    assert ma.oracle_class(v) == expected


def test_oracle_vs_hand_joins_on_arm_name_day_hour():
    key = {"AUD-01": "A", "AUD-02": "A", "AUD-03": "B", "AUD-04": "B"}
    venues = [
        venue("A", "Bar", classes={"alcohol": True}),
        venue("B", "Bar", classes={}),  # same name, other arm: must not be joined to AUD-01
        venue("B", "Park", classes={"unverifiable": True}, hour=9),
    ]
    row = lambda aid, name, hour="17:00", **v: {"audit_id": aid, "venue_name": name, "day": "monday", "hour": hour, "in_recovery": "yes", **v}
    rows = [
        row("AUD-01", "Bar", exists="yes", open_at_slot="yes", serves_alcohol="yes"),
        row("AUD-02", "Ghost", exists="no"),
        row("AUD-03", "Bar", exists="yes", open_at_slot="yes", serves_alcohol="no"),
        row("AUD-04", "Park", hour="09:00", exists="unclear"),
    ]
    assert ma.oracle_vs_hand(rows, key, venues) == {
        "A": {"alcohol": {"ok": 0, "wrong": 1, "inconclusive": 0}, "unmatched": {"ok": 0, "wrong": 1, "inconclusive": 0}},
        "B": {"pass": {"ok": 1, "wrong": 0, "inconclusive": 0}, "unverifiable": {"ok": 0, "wrong": 0, "inconclusive": 1}},
    }


# ---------------------------------------------------------------- summary

def summary_args(**kw):
    return SimpleNamespace(**{"from_handout": "", "auditor": "unspecified", "method": "unspecified", **kw})


def seed_summary(proj):
    proj.keydir.mkdir(parents=True, exist_ok=True)
    with open(ma.KEY, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["audit_id", "arm"])
        for aid, arm in (("AUD-01", "A"), ("AUD-02", "A"), ("AUD-03", "A"), ("AUD-04", "A"), ("AUD-05", "B"), ("AUD-06", "B")):
            w.writerow([aid, arm])
    base = {"day": "monday", "hour": "17:00", "locality": "L", "address": ""}
    rows = [
        {**base, "audit_id": "AUD-01", "venue_name": "Bar One", "in_recovery": "yes", "exists": "yes", "open_at_slot": "yes", "serves_alcohol": "yes"},
        {**base, "audit_id": "AUD-02", "venue_name": "Gone", "in_recovery": "no", "exists": "no"},
        {**base, "audit_id": "AUD-03", "venue_name": "Shut", "in_recovery": "no", "exists": "yes", "open_at_slot": "no"},
        {**base, "audit_id": "AUD-04", "venue_name": "Meh", "in_recovery": "no", "exists": "unclear"},
        {**base, "audit_id": "AUD-05", "venue_name": "Cafe", "in_recovery": "yes", "exists": "yes", "open_at_slot": "yes", "serves_alcohol": "no"},
        {**base, "audit_id": "AUD-06", "venue_name": "Park", "in_recovery": "no", "exists": "yes", "open_at_slot": "yes"},
    ]
    filled_csv(ma.CSV, rows)
    write_results(proj, [
        venue("A", "Bar One", classes={"alcohol": True}), venue("A", "Gone", classes={"unverifiable": True}), venue("A", "Shut", classes={"closed_at_slot": True}),
        venue("B", "Cafe"), venue("B", "Park", classes={"unverifiable": True}),
    ])


def test_summary_from_main_csv(proj, capsys):
    seed_summary(proj)
    ma.summary(summary_args(auditor="Ed", method="maps"))
    out = json.loads((proj.bench / "audit.json").read_text())
    assert out["generated_by"] == "scripts/manual_audit.py summary" and out["auditor"] == "Ed" and out["method"] == "maps"
    assert out["source"] == ma.SOURCE and out["definition"].startswith("wrong = venue not found")
    assert out["finished_at"].endswith("+00:00")
    assert out["arms"] == {
        "A": {"sampled": 4, "checked": 3, "inconclusive": 1, "violations": 3, "rate": 1.0, "not_found": 1, "closed_at_slot": 1, "alcohol": 1},
        "B": {"sampled": 2, "checked": 2, "inconclusive": 0, "violations": 0, "rate": 0.0, "not_found": 0, "closed_at_slot": 0, "alcohol": 0},
    }
    assert out["oracle_vs_hand"]["A"] == {
        "alcohol": {"ok": 0, "wrong": 1, "inconclusive": 0}, "unverifiable": {"ok": 0, "wrong": 1, "inconclusive": 0},
        "closed_at_slot": {"ok": 0, "wrong": 1, "inconclusive": 0}, "unmatched": {"ok": 0, "wrong": 0, "inconclusive": 1},
    }
    assert out["oracle_vs_hand"]["B"] == {"pass": {"ok": 1, "wrong": 0, "inconclusive": 0}, "unverifiable": {"ok": 1, "wrong": 0, "inconclusive": 0}}
    assert json.loads((proj.keydir / "audit_wrong_ids.json").read_text()) == {"A": ["AUD-01", "AUD-02", "AUD-03"], "B": []}
    assert (proj.bench / "audit.json").read_text().endswith("}\n")
    text = capsys.readouterr().out
    assert "  A: wrong 3/3 checked (100.0%) · inconclusive 1 · not found 1 · closed 1 · alcohol 1" in text
    assert "  B: wrong 0/2 checked (0.0%) · inconclusive 0" in text


def test_summary_keeps_recorded_auditor_when_unspecified(proj):
    seed_summary(proj)
    ma.summary(summary_args())
    first = json.loads((proj.bench / "audit.json").read_text())
    assert first["auditor"] == "unspecified" and first["method"] == "unspecified"
    ma.summary(summary_args(auditor="Ed", method="maps"))
    ma.summary(summary_args())
    again = json.loads((proj.bench / "audit.json").read_text())
    assert (again["auditor"], again["method"]) == ("Ed", "maps")
    ma.summary(summary_args(auditor="Sam"))
    assert json.loads((proj.bench / "audit.json").read_text())["auditor"] == "Sam"


def test_summary_all_inconclusive_has_no_rate(proj, capsys):
    seed_summary(proj)
    filled_csv(ma.CSV, [{"audit_id": "AUD-04", "venue_name": "Meh", "exists": "unclear", "in_recovery": "no"}])
    ma.summary(summary_args())
    arm = json.loads((proj.bench / "audit.json").read_text())["arms"]["A"]
    assert arm["rate"] is None and arm["checked"] == 0 and arm["inconclusive"] == 1
    assert "A: wrong 0/0 checked (0.0%)" in capsys.readouterr().out


def test_summary_from_external_handout(proj):
    seed_summary(proj)
    ext = proj.tmp / "ext"
    ext.mkdir()
    with open(ext / "external_audit_map.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["ext_id", "audit_id"])
        w.writerow(["EXT-01", "AUD-02"])
        w.writerow(["EXT-02", "AUD-06"])
    cols = ["ext_id", "venue_name", "address", "locality", "day", "hour", "in_recovery", "exists", "open_at_slot", "serves_alcohol", "source_url", "notes"]
    with open(ext / "filled.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerow({"ext_id": "EXT-01", "venue_name": "Gone", "day": "monday", "hour": "17:00", "in_recovery": "no", "exists": "no"})
        w.writerow({"ext_id": "EXT-02", "venue_name": "Park", "day": "monday", "hour": "17:00", "in_recovery": "no", "exists": "yes", "open_at_slot": "yes"})
    ma.summary(summary_args(from_handout=str(ext / "filled.csv")))
    arms = json.loads((proj.bench / "audit.json").read_text())["arms"]
    assert arms["A"]["sampled"] == 1 and arms["A"]["violations"] == 1 and arms["A"]["not_found"] == 1
    assert arms["B"]["sampled"] == 1 and arms["B"]["rate"] == 0.0


# ---------------------------------------------------------------- main / module constants

def test_main_dispatches_each_command(proj, monkeypatch, capsys):
    write_results(proj, SAMPLE_VENUES)
    monkeypatch.setattr("sys.argv", ["manual_audit.py", "sample", "--n", "2", "--seed", "3", "--force"])
    ma.main()
    assert "wrote 4 rows" in capsys.readouterr().out
    dest = proj.tmp / "hand"
    monkeypatch.setattr("sys.argv", ["manual_audit.py", "handout", "--out", str(dest)])
    ma.main()
    assert (dest / "external_audit_map.csv").exists()
    capsys.readouterr()
    monkeypatch.setattr("sys.argv", ["manual_audit.py", "summary", "--auditor", "Ed", "--method", "m"])
    ma.main()
    assert json.loads((proj.bench / "audit.json").read_text())["auditor"] == "Ed"


def test_main_rejects_unknown_command(monkeypatch):
    monkeypatch.setattr("sys.argv", ["manual_audit.py", "bogus"])
    with pytest.raises(SystemExit) as e:
        ma.main()
    assert e.value.code == 2


def test_key_candidates_prefer_env_then_assets_dir():
    assert ma.KEY_CANDIDATES[1].endswith("assets/audit/manual_audit_key.csv")
    assert ma.KEY_CANDIDATES[2].endswith("bench/manual_audit_key.csv")
    assert ma.KEY in ma.KEY_CANDIDATES
