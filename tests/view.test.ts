import { describe, expect, it } from "vitest";
import type { CardDoc, PlanDoc } from "../lib/store";
import { changedRatings, clampScore, parseScore, coverageRefusal, emberLabel, keptLabel, reviewsByDay, toggleNotice, emberThreads, isOutage, outageState, ratedCount, stampLabel, swapNotice, widerRadius } from "../lib/view";
import { distanceLabel, hoursCheck, passedChecks, priceLabel, rungLabel, printSheet, realRefusals, strikeReason, strikesByDay, traceFromPlan, traceLine, typeLabel, whyParts } from "../lib/view";

const card = (o: Partial<CardDoc> = {}): CardDoc => ({
  id: "c1",
  plan_id: "p",
  day: 3,
  day_name: "thursday",
  hour: 15,
  slot_hour: 18,
  moved_from: 18,
  rung: "solo",
  qloo_entity_id: "E1",
  name: "Patisserie Tomoko",
  entity_type: "urn:entity:place",
  affinity: 0.9,
  distance_m: 1161,
  hours_text: "Thu 12:00–18:00",
  explain_json: [
    { entity_id: "A", name: "Fleabag", score: 0.4579 },
    { entity_id: "B", name: "Phoebe Bridgers", score: 0.5420 },
  ],
  tags: [],
  checks: [
    { rule: "R-ID", verdict: "PASS", detail: "E1" },
    { rule: "R-OPEN", verdict: "PASS", detail: "Thu 12:00–18:00 · slot 15:00" },
    { rule: "R-NEAR", verdict: "PASS", detail: "1161 m" },
  ],
  verdict: "PASS",
  coaching: "",
  routed_by: "llm",
  tool: "findOutings",
  tool_params: { day: "thursday" },
  clinician_action: null,
  pleasure: null,
  mastery: null,
  ...o,
});

describe("ledger view helpers (lib/view.ts)", () => {
  it("why line: per-love explainability split, highest first, two decimals (never the bare affinity)", () => {
    expect(whyParts(card().explain_json)).toEqual([
      { name: "Phoebe Bridgers", weight: "0.54" },
      { name: "Fleabag", weight: "0.46" },
    ]);
    expect(whyParts([])).toEqual([]);
  });

  it("hours check: distance · hours · slot ✓, the re-slot is shown, at-home cards have none", () => {
    expect(hoursCheck(card())).toEqual({ distance: "1161 m", hours: "Thu 12:00–18:00", slot: "slot 15:00", ok: true, moved: "moved from 18:00 (closed then)" });
    expect(hoursCheck(card({ rung: "home" }))).toBeNull();
    expect(hoursCheck(card({ moved_from: undefined }))!.moved).toBeNull();
  });

  it("labels: rung, type, distance, price; checks list only what passed", () => {
    expect(rungLabel({ rung: "home", hour: 19 })).toBe("home · 10 min · 19:00");
    expect(rungLabel({ rung: "social", hour: 14 })).toBe("social · 14:00");
    expect(typeLabel("urn:entity:tv_show")).toBe("TV show");
    expect(distanceLabel(1500)).toBe("≤1.5 km");
    expect(distanceLabel(800)).toBe("≤800 m");
    expect(priceLabel(2)).toBe("≤$$");
    expect(passedChecks(card()).map((x) => x.rule)).toEqual(["R-ID", "R-OPEN", "R-NEAR"]);
  });

  it("strikes are grouped per day, de-duplicated, toggle strikes first, with the rule and the move in the reason", () => {
    const r = (o: Partial<PlanDoc["refusals"][number]>) => ({ id: "r", plan_id: "p", qloo_entity_id: "X", name: "CookUnity", rule: "R-KIND", detail: "not an activity", verdict: "REFUSE" as const, day_name: "sunday" as const, hour: 14, ...o });
    const plan = { cards: [], refusals: [r({}), r({}), r({ qloo_entity_id: "T", name: "Patisserie Tomoko", rule: "R-OPEN", detail: "closes 18:00 · slot 18:00", day_name: "thursday", hour: 18, moved_to: 15 }), r({ qloo_entity_id: "M", name: "The Meat Hook", rule: "R-ALC", detail: "craft_beer", day_name: "thursday", struck_by_toggle: true })] };
    const s = strikesByDay(plan);
    expect(s.sunday).toHaveLength(1);
    expect(s.thursday.map((x) => x.name)).toEqual(["The Meat Hook", "Patisserie Tomoko"]);
    expect(strikeReason(s.thursday[1])).toBe("R-OPEN · closes 18:00 · slot 18:00 · → moved to 15:00");
    expect(strikeReason(s.thursday[0])).toMatch(/^R-ALC · craft_beer · struck when a constraint changed$/);
  });

  it("a stored R-OPEN 'refusal' of the venue placed that day is a move: never struck under itself, never counted", () => {
    const r = (o: Partial<PlanDoc["refusals"][number]>) => ({ id: "r", plan_id: "p", qloo_entity_id: "C", name: "Ceremonia Bakeshop", rule: "R-OPEN", detail: "closes 15:00 · slot 18:00", verdict: "REFUSE" as const, day_name: "thursday" as const, hour: 18, moved_to: 13, ...o });
    const cards = [{ qloo_entity_id: "C", day_name: "thursday" }] as unknown as PlanDoc["cards"];
    const refusals = [r({}), r({ qloo_entity_id: "Z", name: "Zebra Bar", rule: "R-KIND", detail: "not an activity: bar" }), r({ day_name: "friday" })];
    expect(strikesByDay({ cards, refusals }).thursday.map((x) => x.name)).toEqual(["Zebra Bar"]);
    expect(realRefusals(refusals, cards).map((x) => `${x.day_name}:${x.name}`)).toEqual(["thursday:Zebra Bar", "friday:Ceremonia Bakeshop"]);
  });

  it("one strike per venue per day: a venue refused by two rules shows once, naming the other rule", () => {
    const r = (o: Partial<PlanDoc["refusals"][number]>) => ({ id: "r", plan_id: "p", qloo_entity_id: "D", name: "Dokebi Bar and Grill", rule: "R-OPEN", detail: "opens 12:00 · slot 11:00", verdict: "REFUSE" as const, day_name: "saturday" as const, hour: 11, ...o });
    const s = strikesByDay({ cards: [], refusals: [r({}), r({ rule: "R-ALC", detail: "offerings:place:alcohol", struck_by_toggle: true }), r({ day_name: "sunday" })] });
    expect(s.saturday).toHaveLength(1);
    expect(s.saturday[0].rule).toBe("R-ALC");
    expect(strikeReason(s.saturday[0])).toBe("R-ALC · offerings:place:alcohol · also R-OPEN · struck when a constraint changed");
    expect(s.sunday).toHaveLength(1);
  });

  it("trace lines: live events and a stored plan both name the tool, params and refusals by rule", () => {
    expect(traceLine({ type: "tool", tool: "findOutings", params: { day: "thursday", hour: 18 }, returned: 25, refusals: { "R-OPEN": 8, "R-ALC": 2 }, review: 1, card: { name: "Dun-Well Doughnuts" } })).toBe(
      "findOutings day=thursday hour=18 → 25 returned · refused R-OPEN 8, R-ALC 2 · review 1 → Dun-Well Doughnuts ✓",
    );
    expect(traceLine({ type: "qloo" })).toBeNull();
    const plan = { cards: [card()], empty_slots: [{ day_name: "sunday", hour: 14, rung: "social", reason: "Qloo unavailable" }], refusals: [], origin: "agent", toggle: null } as unknown as PlanDoc;
    expect(traceFromPlan(plan)).toEqual(["findOutings day=thursday (llm) → Patisserie Tomoko", "slot → empty: Qloo unavailable"]);
  });
});


describe("gate + re-plan view helpers", () => {
  it("stamp label, rated count with pending edits, and only changed ratings are sent", () => {
    expect(stampLabel("2026-10-07T14:02:33.000Z")).toBe("approved · Wed 7 Oct · 14:02 UTC");
    const cards = [
      { id: "a", pleasure: 7, mastery: 4 },
      { id: "b", pleasure: null, mastery: null },
      { id: "c", pleasure: null, mastery: null },
    ];
    expect(ratedCount(cards, {})).toBe(1);
    expect(ratedCount(cards, { b: { pleasure: 2, mastery: null }, c: { pleasure: null, mastery: 5 } })).toBe(2);
    expect(changedRatings(cards, { a: { pleasure: 7, mastery: 4 }, b: { pleasure: 2, mastery: null }, c: { pleasure: null, mastery: 5 } })).toEqual([{ card_id: "b", pleasure: 2, mastery: null }]);
    expect([clampScore(-1), clampScore(11), clampScore(6.6)]).toEqual([0, 10, 7]);
    // typed scores are never clamped: out of range is invalid and is not saved (QA round 2: 15 saved as 10)
    expect(["", "0", "7", "10", "15", "-1", "6.5", "1e1", "abc"].map(parseScore)).toEqual([null, 0, 7, 10, "invalid", "invalid", "invalid", "invalid", "invalid"]);
  });

  it("ember threads: only top-weighted links, one per week-2 card, with the week-1 rating", () => {
    const diff = {
      from_plan_id: "w1",
      kept: [],
      added: [],
      removed: [], signals: [], kept_check: null,
      ember: [
        { from: "Dun-Well", from_id: "D", to: "Ceremonia", to_id: "C", day: "friday" as const, score: 0.41, top: true },
        { from: "Fleabag", from_id: "F", to: "Ceremonia", to_id: "C", day: "friday" as const, score: 0.41, top: true },
        { from: "Fleabag", from_id: "F", to: "Bakeri", to_id: "B", day: "sunday" as const, score: 0.2, top: false },
      ],
    };
    const t = emberThreads(diff, [{ qloo_entity_id: "D", pleasure: 8 }]);
    expect(t).toEqual([{ from: "Dun-Well", from_id: "D", to: "Ceremonia", to_id: "C", score: 0.41, rated: 8 }]);
    expect(emberLabel(t[0])).toBe("← because of Dun-Well, rated 8 · 0.41");
    expect(emberThreads(null)).toEqual([]);
  });

  it("swap notice names both cards, or says the slot is left empty", () => {
    const before = { name: "Dun-Well", day_name: "friday" as const };
    expect(swapNotice(before, { cards: [card({ day_name: "friday", name: "Ceremonia" })] }, { found: true, ms: 1234, calls: 1 })).toBe("Swapped Dun-Well for Ceremonia, verified the same way (1 Qloo call · 1.2 s).");
    expect(swapNotice(before, { cards: [] }, { found: false, ms: 900, calls: 2 })).toBe("No other verified candidate for Fri; the slot is left empty (2 Qloo calls · 0.9 s).");
  });
});


describe("edge states (D10)", () => {
  const caseRow = { max_meters: 1500, need_quiet: true, need_wheelchair: false, in_recovery: false, price_max: 2 };
  const outing = card({ rung: "solo" });
  it("coverage refusal names the cause per empty outing slot and offers the next radius, never for an outage", () => {
    const plan = {
      cards: [outing],
      empty_slots: [
        { day_name: "sunday" as const, hour: 14, rung: "social" as const, reason: "Qloo returned no places for these filters" },
        { day_name: "saturday" as const, hour: 11, rung: "solo" as const, reason: "no candidate passed all rules (25 checked)" },
        { day_name: "monday" as const, hour: 19, rung: "home" as const, reason: "no verified artist for these loves" },
      ],
    };
    const r = coverageRefusal(plan, caseRow)!;
    expect(r.headline).toBe("Only 1 of 3 outings could be verified within 1.5 km (quiet, ≤$$), open at the slot.");
    expect(r.slots.map((x) => x.line)).toEqual(["Sun 14:00 social: Qloo returned no places for these filters", "Sat 11:00 solo: no candidate passed all rules (25 checked)"]);
    expect(r.widen).toBe(3000);
    expect(widerRadius(5000)).toBeNull();
    expect(coverageRefusal({ cards: [outing], empty_slots: [{ day_name: "sunday", hour: 14, rung: "social", reason: "Qloo unavailable (503) — slot left empty" }] }, caseRow)).toBeNull();
    expect(coverageRefusal({ cards: [outing], empty_slots: [] }, caseRow)).toBeNull();
  });
  it("coverage names the binding filter from the live probe and offers that relaxation beside widening (QA round 2: Cal)", () => {
    const e = (day: "saturday" | "sunday" | "thursday", relax: { quiet?: number; price?: number }) => ({ day_name: day, hour: 14, rung: "solo" as const, reason: "Qloo returned no places for these filters", relax });
    const plan = { cards: [outing], empty_slots: [e("thursday", { quiet: 4, price: 0 }), e("saturday", { quiet: 2, price: 1 }), e("sunday", { quiet: 0, price: 0 })] };
    const r = coverageRefusal(plan, caseRow)!;
    expect(r.relax.map((x) => [x.key, x.fills])).toEqual([["quiet", 2], ["price", 1]]);
    expect(r.relax[0].patch).toEqual({ need_quiet: false });
    expect(r.relax[1].patch).toEqual({ price_max: 3 });
    expect(r.binding).toBe("Live check: without “quiet”, 2 of 3 empty outings would have a verified candidate; with budget ≤$$$, 1 of 3 empty outings would have a verified candidate.");
    const none = coverageRefusal({ cards: [outing], empty_slots: [e("sunday", { quiet: 0, price: 0 })] }, caseRow)!;
    expect(none.relax).toEqual([]);
    expect(none.binding).toMatch(/would not fill it; the radius is the remaining lever/);
  });
  it("outage state counts outage-empty slots and says whether it was the labelled demo", () => {
    expect(isOutage("Qloo unavailable (network) — slot left empty")).toBe(true);
    expect(isOutage("no verified artist")).toBe(false);
    const e = { day_name: "monday" as const, hour: 19, rung: "home" as const, reason: "Qloo unavailable (network) — slot left empty" };
    expect(outageState({ empty_slots: [e, e], fault: "qloo_unreachable" })).toEqual({ slots: 2, injected: true });
    expect(outageState({ empty_slots: [e], fault: null })).toEqual({ slots: 1, injected: false });
    expect(outageState({ empty_slots: [], fault: null })).toBeNull();
  });
});

describe("patient print view", () => {
  const base = { id: "c", plan_id: "p", slot_hour: 15, qloo_entity_id: "E", affinity: 0.9, explain_json: [{ entity_id: "B", name: "Phoebe Bridgers", score: 0.54 }], tags: [], checks: [], verdict: "PASS" as const, routed_by: "llm" as const, tool_params: {}, pleasure: null, mastery: null };
  const cards = [
    { ...base, id: "a", day: 3, day_name: "thursday" as const, hour: 15, rung: "solo" as const, name: "Dun-Well Doughnuts", entity_type: "urn:entity:place", address: "222 Montrose Ave Brooklyn, NY 11206", coaching: "Go at 15:00; twenty minutes is enough.", clinician_action: "approved" as const },
    { ...base, id: "b", day: 0, day_name: "monday" as const, hour: 19, rung: "home" as const, home_type: "artist" as const, name: "Lucy Dacus", entity_type: "urn:entity:artist", coaching: "Put on one song.", clinician_action: "approved" as const },
    { ...base, id: "c", day: 1, day_name: "tuesday" as const, hour: 19, rung: "home" as const, home_type: "podcast" as const, name: "Not approved", entity_type: "urn:entity:podcast", coaching: "x", clinician_action: null },
  ];

  it("a draft week prints nothing; an approved week prints approved cards in day order, without weights or rules", () => {
    expect(printSheet({ status: "draft", cards: cards as never })).toEqual({ printable: false, rows: [] });
    const p = printSheet({ status: "approved", cards: cards as never });
    expect(p.printable).toBe(true);
    expect(p.rows.map((r) => r.activity)).toEqual(["Lucy Dacus", "Dun-Well Doughnuts"]);
    expect(p.rows[0]).toEqual({ day: "Monday", time: "19:00 · about 10 minutes", activity: "Lucy Dacus", kind: "artist", where: "at home", how: "Put on one song." });
    expect(p.rows[1].where).toBe("222 Montrose Ave Brooklyn, NY 11206");
    expect(JSON.stringify(p.rows)).not.toMatch(/0\.54|R-|Bridgers/);
  });
});

describe("kept activity on a re-plan (QA round 1)", () => {
  it("only a kept card carries the ember 'kept' mark, with the rating it got", () => {
    expect(keptLabel({ routed_by: "kept", tool_params: { day: "thursday", kept: true, rated: 9 } })).toBe("↻ kept from last week, rated 9 · re-checked live");
    expect(keptLabel({ routed_by: "llm", tool_params: {} })).toBeNull();
  });
});

describe("constraint toggle notice (QA round 1: widen copy)", () => {
  const caseA = { max_meters: 1500, price_max: 2, in_recovery: false, need_quiet: true, need_wheelchair: false };
  const before = { id: "p1", cards: [{ day_name: "monday" }], empty_slots: [{ day_name: "thursday", rung: "solo" }, { day_name: "saturday", rung: "solo" }, { day_name: "sunday", rung: "social" }] } as unknown as PlanDoc;
  const after = (cards: string[], toggle: { struck: number; refilled: number; ms: number }) => ({ id: "p2", cards: cards.map((d) => ({ day_name: d })), toggle: { changed: {}, ...toggle } }) as unknown as PlanDoc;

  it("widening reports the live retry of the empty outings, with how many filled", () => {
    expect(toggleNotice(before, caseA, after(["monday", "saturday"], { struck: 0, refilled: 3, ms: 2100 }), { ...caseA, max_meters: 3000 })).toBe("Retried 3 empty outings within 3 km: 1 filled, 2 still empty · 2.1 s. The verified cards stay as they were.");
    expect(toggleNotice(before, caseA, after(["monday"], { struck: 0, refilled: 3, ms: 2100 }), { ...caseA, max_meters: 3000 })).toMatch(/^Retried 3 empty outings within 3 km: 0 filled/);
    expect(toggleNotice(before, caseA, after(["monday", "thursday"], { struck: 0, refilled: 3, ms: 900 }), { ...caseA, need_quiet: false })).toMatch(/^Retried 3 empty outings under the new setting: 1 filled/);
  });

  it("tightening reports strikes; no change says so", () => {
    expect(toggleNotice(before, caseA, after(["monday"], { struck: 2, refilled: 2, ms: 3000 }), { ...caseA, in_recovery: true })).toBe("2 outings struck in place and 2 slots refilled live · 3.0 s");
    expect(toggleNotice(before, caseA, after(["monday"], { struck: 0, refilled: 0, ms: 500 }), { ...caseA, in_recovery: true })).toBe("Every placed outing still passes the new constraint (0.5 s).");
    expect(toggleNotice(before, caseA, before, caseA)).toBe("No change to the week.");
  });
});

describe("REVIEW boxes (QA round 1: the same venue twice)", () => {
  it("dedupes review items by entity across the week (first day wins) and drops one already placed", () => {
    const r = (id: string, day: CardDoc["day_name"], d: number) => ({ qloo_entity_id: id, day_name: day, day: d, name: id }) as unknown as CardDoc;
    const plan = { cards: [{ qloo_entity_id: "PLACED" }] as unknown as CardDoc[], review: [r("VL", "sunday", 6), r("VL", "saturday", 5), r("VL", "sunday", 6), r("VL2", "sunday", 6), r("PLACED", "friday", 4)] };
    const by = reviewsByDay(plan);
    expect(by.saturday.map((x) => x.qloo_entity_id)).toEqual(["VL"]);
    expect(by.sunday.map((x) => x.qloo_entity_id)).toEqual(["VL2"]);
    expect(by.friday).toEqual([]);
  });
});
