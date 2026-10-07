import { describe, expect, it } from "vitest";
import type { CardDoc, PlanDoc } from "../lib/store";
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
