import { describe, expect, it } from "vitest";
import type { CardDoc, PlanDoc } from "../lib/store";
import { changedRatings, clampScore, coverageRefusal, emberLabel, emberThreads, isOutage, outageState, ratedCount, stampLabel, swapNotice, widerRadius } from "../lib/view";
import { distanceLabel, hoursCheck, passedChecks, priceLabel, rungLabel, strikeReason, strikesByDay, traceFromPlan, traceLine, typeLabel, whyParts } from "../lib/view";

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
  });

  it("ember threads: only top-weighted links, one per week-2 card, with the week-1 rating", () => {
    const diff = {
      from_plan_id: "w1",
      kept: [],
      added: [],
      removed: [],
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
  it("outage state counts outage-empty slots and says whether it was the labelled demo", () => {
    expect(isOutage("Qloo unavailable (network) — slot left empty")).toBe(true);
    expect(isOutage("no verified artist")).toBe(false);
    const e = { day_name: "monday" as const, hour: 19, rung: "home" as const, reason: "Qloo unavailable (network) — slot left empty" };
    expect(outageState({ empty_slots: [e, e], fault: "qloo_unreachable" })).toEqual({ slots: 2, injected: true });
    expect(outageState({ empty_slots: [e], fault: null })).toEqual({ slots: 1, injected: false });
    expect(outageState({ empty_slots: [], fault: null })).toBeNull();
  });
});
