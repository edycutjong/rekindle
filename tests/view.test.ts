import { describe, expect, it } from "vitest";
import type { CardDoc, PlanDoc } from "../lib/store";
import { EMBER_MIN_MARGIN, diffWeeks, emberLead, explainMargin } from "../lib/replan";
import type { WeekPlan } from "../lib/plan";
import { EMPTY_HISTORY } from "../lib/plan";
import { changedRatings, clampScore, parseScore, coverageRefusal, emberLabel, keptLabel, reviewsByDay, toggleNotice, emberThreads, isOutage, outageState, ratedCount, stampLabel, swapNotice, widerRadius } from "../lib/view";
import { distanceLabel, hoursCheck, passedChecks, priceLabel, rungLabel, printSheet, realRefusals, strikeReason, strikesByDay, traceFromPlan, traceLine, typeLabel, whyParts } from "../lib/view";
import { isToolFailure, leadShown, llmFailure, reviewReason, routingLabel, shortDetail, tagKind, tagLeaf } from "../lib/view";
import { EMPTY } from "../lib/empty";
import { runAgent } from "../lib/agent";
import type { QlooClient } from "../lib/qloo";
import { MAYA, replayClient } from "./replay";

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
    // the tag prints by its own name; the namespace path ("offerings:place:") stays in the title (QA 2026-10-09)
    expect(strikeReason(s.saturday[0])).toBe("R-ALC · alcohol · also R-OPEN · struck when a constraint changed");
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

  it("ember threads: a clear lead (≥ EMBER_MIN_MARGIN) threads 'because of'; a tie or sub-threshold lead gets no thread (QA round 3)", () => {
    const ex = (pairs: [string, string, number][]) => pairs.map(([entity_id, name, score]) => ({ entity_id, name, score }));
    const diff = {
      from_plan_id: "w1",
      kept: [],
      added: [],
      removed: [], signals: [], kept_check: null,
      ember: [
        { from: "Lucy Dacus", from_id: "L", to: "Seek Treatment", to_id: "S", day: "friday" as const, score: 0.35, top: true },
        { from: "Lucy Dacus", from_id: "L", to: "Ceremonia", to_id: "C", day: "saturday" as const, score: 0.41, top: true },
        { from: "Lucy Dacus", from_id: "L", to: "Bakeri", to_id: "B", day: "sunday" as const, score: 0.2, top: false },
      ],
    };
    const cards = [
      // the live re-plan bc750936: 0.3500 vs 0.3470 — a displayed tie
      { qloo_entity_id: "S", explain_json: ex([["L", "Lucy Dacus", 0.35], ["F", "Fleabag", 0.347], ["P", "Phoebe Bridgers", 0.303]]) },
      { qloo_entity_id: "C", explain_json: ex([["L", "Lucy Dacus", 0.41], ["F", "Fleabag", 0.3], ["P", "Phoebe Bridgers", 0.29]]) },
      { qloo_entity_id: "B", explain_json: ex([["F", "Fleabag", 0.5], ["L", "Lucy Dacus", 0.2]]) },
    ];
    const t = emberThreads(diff, [{ qloo_entity_id: "L", pleasure: 9 }], cards);
    expect(t.map((x) => [x.to_id, x.tied])).toEqual([["S", true], ["C", false]]);
    expect(emberLabel(t[0]!)).toBe("with Lucy Dacus, rated 9 · tied with Fleabag (0.350 vs 0.347)");
    expect(emberLabel(t[1]!)).toBe("← because of Lucy Dacus, rated 9 · 0.410, +0.110 over Fleabag (original love)");
    // the stored `top` flag alone never threads a tie: margins come from the card's own explainability
    expect(t.filter((x) => !x.tied).map((x) => x.to_id)).toEqual(["C"]);
    // a stored diff (before margins) without cards: the old `top` links are kept but count as a zero-lead tie
    expect(emberThreads(diff, []).every((x) => x.tied)).toBe(true);
    expect(emberThreads(null)).toEqual([]);
  });

  it("QA round 4 (a2a r08): the ember thread measures the top RATED input against the best ORIGINAL LOVE, so two ratings no longer cancel each other's thread; the other rating is a co-input", () => {
    const why = (pairs: [string, string, number][]) => pairs.map(([entity_id, name, score]) => ({ entity_id, name, score }));
    const week = (cards: { id: string; name: string; why: ReturnType<typeof why> }[]) =>
      ({ slots: cards.map((c, i) => ({ slot: { day: (["friday", "saturday", "sunday"] as const)[i], hour: 15, rung: "social" }, card: { entity_id: c.id, name: c.name, why: c.why } })) }) as unknown as WeekPlan;
    const h = { ...EMPTY_HISTORY, rekindled: [{ entity_id: "L", name: "Lucy Dacus", tags: [], entityType: "urn:entity:artist" }, { entity_id: "B", name: "Big Thief", tags: [], entityType: "urn:entity:artist" }] };
    const lead = why([["L", "Lucy Dacus", 0.36], ["B", "Big Thief", 0.35], ["F", "Fleabag", 0.29]]);
    const loveWins = why([["F", "Fleabag", 0.4], ["L", "Lucy Dacus", 0.36], ["B", "Big Thief", 0.35]]);
    // the old rule: 0.36 leads the NEXT input (the other rating, 0.35) by 0.01 → a tie, no thread
    expect(explainMargin(lead, "L")).toBeLessThan(EMBER_MIN_MARGIN);
    // the new rule: 0.36 leads the best original love (0.29) by 0.07 → a thread, Big Thief carried as a co-input
    expect(emberLead(lead, new Set(["L", "B"]))).toMatchObject({ top: { entity_id: "L" }, love: { entity_id: "F" }, margin: 0.07, threads: true, co: [{ entity_id: "B" }] });
    const d = diffWeeks(week([]), week([{ id: "S", name: "Seek Treatment", why: lead }, { id: "C", name: "Ceremonia", why: loveWins }]), h);
    expect(d.ember.filter((e) => e.top).map((e) => [e.to_id, e.from_id, e.margin])).toEqual([["S", "L", 0.07]]);
    expect(d.ember.find((e) => e.to_id === "S" && e.from_id === "B")).toMatchObject({ top: false, margin: 0.06 });
    const cards = [
      { qloo_entity_id: "S", explain_json: lead },
      { qloo_entity_id: "C", explain_json: loveWins },
    ];
    const t = emberThreads({ from_plan_id: "w1", kept_check: null, ...d }, [{ qloo_entity_id: "L", pleasure: 9 }, { qloo_entity_id: "B", pleasure: 8 }], cards, ["L", "B"]);
    // the best original love beats every rated input on Ceremonia → no link at all (no thread, no tie label)
    expect(t.map((x) => [x.to_id, x.from_id, x.tied])).toEqual([["S", "L", false]]);
    expect(emberLabel(t[0]!)).toBe("← because of Lucy Dacus, rated 9 · 0.360, +0.070 over Fleabag (original love) · with Big Thief 0.350");
    expect(emberLead(loveWins, new Set(["L", "B"]))!.margin).toBeLessThan(0);
    // a rated input that only edges the loves stays a tie, whatever the other rating does
    const edge = emberLead(why([["L", "Lucy Dacus", 0.31], ["F", "Fleabag", 0.3]]), new Set(["L"]));
    expect(edge).toMatchObject({ threads: false, co: [] });
    // no original love on the card: the rated input's own weight is the lead; no rated input with weight → null
    expect(emberLead(why([["L", "Lucy Dacus", 0.5]]), new Set(["L"]))).toMatchObject({ love: null, margin: 0.5, threads: true });
    expect(emberLead(why([["F", "Fleabag", 0.5], ["L", "Lucy Dacus", 0]]), new Set(["L"]))).toBeNull();
  });

  it("QA round 5 (assets QA, 2026-10-09): an ember lead is the difference of the PRINTED weights, a re-planned week prints 3 decimals, refused tags print by leaf, intake tag chips by kind", () => {
    // live re-plan e0adf88a, Sunday (Bushwick Pita Palace): the raw lead 0.0724 printed "+0.072" beside 0.307 and 0.234
    const why = [
      { entity_id: "D", name: "Dun-Well Doughnuts", score: 0.3066466350272131 },
      { entity_id: "L", name: "Lucy Dacus", score: 0.2386199619456472 },
      { entity_id: "P", name: "Phoebe Bridgers", score: 0.23424643188330097 },
      { entity_id: "F", name: "Fleabag", score: 0.2204869711438387 },
    ];
    const diff = { from_plan_id: "w1", kept: [], added: [], removed: [], signals: [], kept_check: null, ember: [{ from: "Dun-Well Doughnuts", from_id: "D", to: "Bushwick Pita Palace", to_id: "B", day: "sunday" as const, score: why[0]!.score, top: true }] };
    const [t] = emberThreads(diff, [{ qloo_entity_id: "D", pleasure: 8 }, { qloo_entity_id: "L", pleasure: 7 }], [{ qloo_entity_id: "B", explain_json: why }], ["D", "L"]);
    expect(t!.margin).toBeCloseTo(0.0724, 4);
    expect(t!.love_score).toBe(0.23424643188330097);
    expect(whyParts(why, 3).map((p) => p.weight)).toEqual(["0.307", "0.239", "0.234"]);
    expect(leadShown(t!)).toBe("0.073");
    expect(emberLabel(t!)).toBe("← because of Dun-Well Doughnuts, rated 8 · 0.307, +0.073 over Phoebe Bridgers (original love) · with Lucy Dacus 0.239");
    // Saturday of the same week: printed and raw leads agree (0.296 − 0.252)
    expect(leadShown({ score: 0.2960061549573592, margin: 0.044086, love_score: 0.251919882986588 })).toBe("0.044");
    // a stored link without explainability falls back to score − margin
    expect(leadShown({ score: 0.41, margin: 0.11, love_score: null })).toBe("0.110");
    // R-ALC lists Qloo tag paths; the sheet prints each tag's own name once, so a line never breaks inside "qloo:bar_service"
    expect(tagLeaf("service_type:qloo:bar_service")).toBe("bar_service");
    expect(tagLeaf("genre:place:restaurant:cocktail_bar")).toBe("cocktail_bar");
    for (const keep of ["craft_beer", "bar", "not an activity: personal_care", "closes 18:00 · slot 18:00", "18:00"]) expect(tagLeaf(keep)).toBe(keep);
    expect(shortDetail("service_type:qloo:bar_service, beverage_offering:qloo:wine, amenity:qloo:wine, amenity:qloo:full_bar")).toBe("bar_service, wine +1 more");
    expect(reviewReason([{ rule: "R-ALC", verdict: "REVIEW", detail: "offerings:place:happy_hour, offerings:place:ok_to_order_just_drinks" }, { rule: "R-OPEN", verdict: "PASS", detail: "Sun 07:00–21:00 · slot 14:00" }])).toBe("R-ALC · happy_hour, ok_to_order_just_drinks");
    // Qloo names all three top /v2/tags matches for "bakery" just "Bakery": the chip says which kind of tag each is
    const bakery = ["urn:tag:genre:place:restaurant:bakery", "urn:tag:category:place:bakery", "urn:tag:offerings:place:bakery"];
    expect(bakery.map((id) => tagKind(id, bakery))).toEqual(["genre", "category", "offerings"]);
    const clash = ["urn:tag:genre:place:restaurant:bakery", "urn:tag:genre:place:hotel:bakery"];
    expect(clash.map((id) => tagKind(id, clash))).toEqual(["genre · restaurant", "genre · hotel"]);
    expect(tagKind("urn:tag:dining_option:qloo:bakery")).toBe("dining option");
  });

  it("diffWeeks marks top only above the margin and stores the margin", () => {
    const why = [{ entity_id: "L", name: "Lucy Dacus", score: 0.3495 }, { entity_id: "P", name: "Phoebe Bridgers", score: 0.3463 }];
    expect(explainMargin(why, "L")).toBeCloseTo(0.0032, 6);
    expect(explainMargin(why, "P")).toBeLessThan(0);
    expect(EMBER_MIN_MARGIN).toBe(0.02);
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
  it("QA round 4: a slot whose tool failed says so and is not a coverage refusal (no 'widen the radius' for a code error)", () => {
    const failed = { day_name: "thursday" as const, hour: 18, rung: "solo" as const, reason: "tool failed (TypeError) — slot left empty" };
    expect(coverageRefusal({ cards: [outing], empty_slots: [failed] }, caseRow)).toBeNull();
    expect(coverageRefusal({ cards: [outing], empty_slots: [{ ...failed, reason: "not routed: its tool call did not finish" }] }, caseRow)).toBeNull();
    expect(isOutage(failed.reason)).toBe(false); // the Qloo-outage banner stays for Qloo outages only
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

describe("QA 2026-10-09 (demo video): the trace says what failed, and the stats credit every provider that routed", () => {
  const fb = (o: Record<string, unknown>) => traceLine({ type: "llm_fallback", from: "groq:openai/gpt-oss-120b", to: null, error: "x", ...o });
  it("a coaching failure says coaching → template lines; a routing failure says why and where it goes", () => {
    const tpm = "AI_APICallError: Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Used 6686, Requested 1462.";
    expect(fb({ stage: "coach", error: tpm })).toBe("coaching groq:openai/gpt-oss-120b rate-limited → template lines");
    expect(fb({ stage: "route", from: "qwen:qwen3.8-flash", to: "groq:openai/gpt-oss-120b", error: "TimeoutError: The operation was aborted due to timeout", open: 6 })).toBe(
      "LLM fallback qwen:qwen3.8-flash (timed out) → groq:openai/gpt-oss-120b",
    );
    expect(fb({ stage: "route", error: tpm, open: 0 })).toBe("LLM groq:openai/gpt-oss-120b rate-limited after every slot was routed · nothing left to fall back on");
    expect(fb({ stage: "route", error: "Error: the model made no progress (no tool called)", open: 2 })).toBe("LLM fallback groq:openai/gpt-oss-120b (made no tool call) → deterministic route for 2 slots");
    // an event from before the stage field (an older stream) keeps the old reading
    expect(fb({ error: "AI_APICallError: model overloaded" })).toBe("LLM fallback groq:openai/gpt-oss-120b (failed) → deterministic route");
    expect(llmFailure("Error: 429 Too Many Requests")).toBe("rate-limited");
  });

  it("routingLabel lists each LLM with its card count, then the other routes; older plans keep the single label", () => {
    const plan = (cards: Partial<CardDoc>[], llm: [string | null, string | null] = ["qwen", "qwen3.8-flash"]) =>
      ({ llm_provider: llm[0], llm_model: llm[1], cards: cards.map((c) => card(c)) }) as unknown as PlanDoc;
    const q = { routed_by: "llm" as const, routed_llm: "qwen:qwen3.8-flash" };
    const g = { routed_by: "llm" as const, routed_llm: "groq:openai/gpt-oss-120b" };
    expect(routingLabel(plan([g, g, g, g, g, q, { routed_by: "kept" }]))).toBe("groq:openai/gpt-oss-120b ×5 · qwen:qwen3.8-flash ×1 · kept ×1");
    expect(routingLabel(plan([q, q, q, q, { routed_by: "toggle" }, { routed_by: "toggle" }, { routed_by: "toggle" }]))).toBe("qwen:qwen3.8-flash ×4 · toggle refill ×3");
    expect(routingLabel(plan([q, q, q, q, q, { routed_by: "fallback" }, { routed_by: "fallback" }]))).toBe("qwen:qwen3.8-flash ×5 · deterministic ×2");
    // plans stored before cards named their provider
    expect(routingLabel(plan([{ routed_by: "llm" }, { routed_by: "llm" }]))).toBe("qwen:qwen3.8-flash");
    expect(routingLabel(plan([{ routed_by: "fallback" }], [null, null]))).toBe("deterministic route");
    // a2a r09: no card placed by a model → no model named, even if the stored plan credited one
    expect(routingLabel(plan([{ routed_by: "kept" }, { routed_by: "fallback" }]))).toBe("deterministic ×1 · kept ×1");
    expect(routingLabel(plan([{ routed_by: "fallback" }]))).toBe("deterministic route");
  });
});

describe("a2a r09: empty-slot reasons are state, matched by one prefix", () => {
  it("every producer's sentence starts with its EMPTY prefix, and the readers classify it", async () => {
    const outage = await runAgent({ qloo: replayClient([], true), case: MAYA, llms: [] });
    const outageReasons = outage.slots.filter((s) => s.slot.rung !== "home").map((s) => s.empty ?? "");
    expect(outageReasons.length).toBeGreaterThan(0);
    for (const r of outageReasons) expect(r.startsWith(EMPTY.outage) && isOutage(r)).toBe(true);
    // a Qloo client that throws something other than a QlooError: every empty slot still classifies (lib/plan.ts)
    const broken = { insights: async () => { throw new TypeError("boom"); } } as unknown as QlooClient;
    const failed = await runAgent({ qloo: broken, case: MAYA, llms: [] });
    const reasons = failed.slots.filter((s) => !s.card).map((s) => s.empty ?? "");
    expect(reasons.length).toBeGreaterThan(0);
    for (const r of reasons) expect(isOutage(r) || isToolFailure(r)).toBe(true);
    expect(isToolFailure(`${EMPTY.toolFailed} (TypeError) — slot left empty`)).toBe(true);
    expect(isToolFailure(`${EMPTY.notRouted}: its tool call did not finish`)).toBe(true);
    expect(isOutage("no verified candidate") || isToolFailure("no verified candidate")).toBe(false);
  });
});
