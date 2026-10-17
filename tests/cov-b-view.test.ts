import { describe, expect, it } from "vitest";
import type { CardDoc, PlanDoc } from "../lib/store";
import { coverageRefusal, emberLabel, emberThreads, hoursCheck, keptLabel, llmFailure, lovedTokens, passedChecks, printSheet, routingLabel, tagKind, toggleNotice, traceFromPlan, traceLine, typeLabel, whyParts } from "../lib/view";

const card = (o: Partial<CardDoc> = {}): CardDoc => ({
  id: "c1",
  plan_id: "p",
  day: 3,
  day_name: "thursday",
  hour: 15,
  slot_hour: 15,
  rung: "solo",
  qloo_entity_id: "E1",
  name: "Tomoko",
  entity_type: "urn:entity:place",
  affinity: 0.9,
  explain_json: [],
  tags: [],
  checks: [],
  verdict: "PASS",
  coaching: "go",
  routed_by: "llm",
  tool_params: {},
  clinician_action: null,
  pleasure: null,
  mastery: null,
  ...o,
});

describe("view: labels and small helpers", () => {
  it.each([
    ["urn:entity:foo_bar", "foo bar"],
    ["urn:tag:some_tag", "some tag"],
    ["urn:entity:movie", "film"],
    [undefined, "tag"],
  ])("typeLabel(%s) = %s", (t, want) => expect(typeLabel(t)).toBe(want));

  it("whyParts falls back to the entity id when a love has no name", () => {
    expect(whyParts([{ entity_id: "E9", name: "", score: 0.5 }, { entity_id: "E8", name: "Named", score: 0.25 }])).toEqual([
      { name: "E9", weight: "0.50" },
      { name: "Named", weight: "0.25" },
    ]);
  });

  it("hoursCheck leaves distance and hours null when the card carries neither; home cards have none", () => {
    expect(hoursCheck(card())).toEqual({ distance: null, hours: null, slot: "slot 15:00", ok: false, moved: null });
    expect(hoursCheck(card({ rung: "home" }))).toBeNull();
  });

  it("passedChecks of a home card is only its passing R-ID", () => {
    const c = card({ rung: "home", checks: [{ rule: "R-ID", verdict: "PASS", detail: "x" }, { rule: "R-ID", verdict: "REFUSE", detail: "y" }, { rule: "R-OPEN", verdict: "PASS", detail: "z" }] });
    expect(passedChecks(c)).toEqual([{ rule: "R-ID", detail: "a Qloo entity returned in this run" }]);
  });

  it.each([
    ["urn:tag:", [], "tag"],
    ["urn:tag:genre:bakery", ["urn:tag:genre:cafe"], "genre"],
    ["urn:tag:genre:place:restaurant:bakery", ["urn:tag:genre:place:hotel:motel"], "genre · restaurant"],
    ["urn:tag:category_x:bakery", [], "category x"],
  ])("tagKind(%s)", (id, sib, want) => expect(tagKind(id, sib)).toBe(want));

  it("lovedTokens: a tag love is 'tag', an entity love names its type, and a missing name falls back to the typed text", () => {
    const loves = [
      { id: "1", text: "bakery", qloo_id: "t", qloo_kind: "tag" as const, name: "Bakery", weight: 1 },
      { id: "2", text: "fleabag", qloo_id: "e", qloo_kind: "entity" as const, entity_type: "urn:entity:tv_show", weight: 1 },
    ];
    expect(lovedTokens({ loves })).toEqual([{ kind: "tag", name: "Bakery" }, { kind: "TV show", name: "fleabag" }]);
  });

  it.each([
    [undefined, "failed"],
    [null, "failed"],
    ["token budget spent", "spent its routing token budget"],
    ["HTTP 429", "rate-limited"],
    ["aborted", "timed out"],
    ["no tool called", "made no tool call"],
    ["no placed card", "no usable coaching line"],
  ])("llmFailure(%s) = %s", (e, want) => expect(llmFailure(e)).toBe(want));

  it("keptLabel omits the rating when tool_params.rated is not a number", () => {
    expect(keptLabel({ routed_by: "kept", tool_params: { rated: "9" } })).toBe("↻ kept from last week · re-checked live");
    expect(keptLabel({ routed_by: "kept", tool_params: { rated: 9 } })).toBe("↻ kept from last week, rated 9 · re-checked live");
    expect(keptLabel({ routed_by: "llm", tool_params: {} })).toBeNull();
  });
});

describe("view: traces", () => {
  it("traceFromPlan prints the constraint change line for a toggle plan and the refused rules per day", () => {
    const plan = {
      origin: "toggle",
      toggle: { changed: { need_quiet: true, max_meters: 800 }, struck: 2, refilled: 1, ms: 2500 },
      cards: [card()],
      empty_slots: [],
      refusals: [{ id: "r", plan_id: "p", qloo_entity_id: "X", name: "Bar", rule: "R-ALC", detail: "beer", verdict: "REFUSE", day_name: "thursday", hour: 18 }],
    } as unknown as PlanDoc;
    const lines = traceFromPlan(plan);
    expect(lines[0]).toBe("constraint change need_quiet=true, max_meters=800 → struck 2 · refilled 1 · 2.5 s");
    expect(lines[1]).toBe("slot (llm) → Tomoko · refused R-ALC 1");
  });

  it("traceFromPlan of an empty slot with no strikes has no refused suffix and no route", () => {
    const plan = { origin: "agent", toggle: null, cards: [], empty_slots: [{ day_name: "sunday", hour: 14, rung: "solo", reason: "none" }], refusals: [] } as unknown as PlanDoc;
    expect(traceFromPlan(plan)).toEqual(["slot → empty: none"]);
  });

  const table: [string, Record<string, unknown>, string | null][] = [
    ["start with LLMs", { type: "start", week: 1, slots: [1, 2], llm: ["qwen", "groq"] }, "start week 1 · 2 slots · LLM qwen → groq"],
    ["start without LLMs", { type: "start", week: 2, slots: [], llm: [] }, "start week 2 · 0 slots · LLM none (deterministic)"],
    ["llm one call", { type: "llm", provider: "qwen", model: "m", step: 1, toolCalls: ["a"], ms: 5 }, "qwen:m step 1 · 1 tool call · 5 ms"],
    ["llm many calls", { type: "llm", provider: "qwen", model: "m", step: 2, toolCalls: ["a", "b"], ms: 6 }, "qwen:m step 2 · 2 tool calls · 6 ms"],
    ["fallback without open count", { type: "llm_fallback", from: "qwen", error: "timeout" }, "LLM fallback qwen (timed out) → deterministic route"],
    ["fallback one open slot", { type: "llm_fallback", from: "qwen", error: "timeout", open: 1 }, "LLM fallback qwen (timed out) → deterministic route for 1 slot"],
    ["fallback many open slots", { type: "llm_fallback", from: "qwen", error: "timeout", open: 3 }, "LLM fallback qwen (timed out) → deterministic route for 3 slots"],
    ["tool with everything", { type: "tool", tool: "findOutings", params: { day: "mon" }, refusals: { "R-ALC": 2 }, returned: 5, review: 1, card: { name: "X" } }, "findOutings day=mon → 5 returned · refused R-ALC 2 · review 1 → X ✓"],
    ["tool with nothing optional", { type: "tool", tool: "findOutings", returned: 0 }, "findOutings → 0 returned → empty: no verified candidate"],
    ["tool with empty reason", { type: "tool", tool: "t", returned: 0, empty: "closed" }, "t → 0 returned → empty: closed"],
    ["tool_rejected", { type: "tool_rejected", tool: "findOutings", day: "mon", reason: "bad" }, "rejected findOutings mon: bad"],
    ["truth_boundary", { type: "truth_boundary", dropped: [1, 2] }, "truth boundary dropped 2 line(s)"],
    ["unknown event", { type: "plan" }, null],
  ];
  it.each(table)("traceLine: %s", (_n, e, want) => expect(traceLine(e as { type: string })).toBe(want));
});

describe("view: routingLabel", () => {
  const plan = (cards: Partial<CardDoc>[], llm_model: string | null = null) => ({ cards: cards.map((c) => card(c)), llm_provider: "qwen", llm_model }) as Pick<PlanDoc, "cards" | "llm_provider" | "llm_model">;
  it("LLM cards that predate routed_llm and no model recorded read as deterministic", () => {
    expect(routingLabel(plan([{ routed_by: "llm" }]))).toBe("deterministic route");
    expect(routingLabel(plan([{ routed_by: "llm" }], "m"))).toBe("qwen:m");
  });
  it("mixes named providers, the anonymous 'LLM', and ties sorted by name", () => {
    expect(routingLabel(plan([{ routed_by: "llm", routed_llm: "qwen:a" }, { routed_by: "llm" }, { routed_by: "llm", routed_llm: "groq:b" }]))).toBe("groq:b ×1 · LLM ×1 · qwen:a ×1");
  });
});

describe("view: emberThreads and labels", () => {
  const ember = (o: Partial<{ from: string; from_id: string; to: string; to_id: string; score: number; top: boolean; margin: number }> = {}) => ({ from: "Lucy", from_id: "L", to: "Pick", to_id: "P", day: "monday" as const, score: 0.5, top: true, ...o });
  const diff = (e: ReturnType<typeof ember>[]) => ({ from_plan_id: "x", kept: [], added: [], removed: [], signals: [], kept_check: null, ember: e });

  it("no diff: no links", () => expect(emberThreads(null)).toEqual([]));

  it("with explainability: names fall back to the entity's own name or id, rated defaults to null, love-less cards have no runner-up", () => {
    const links = emberThreads(
      diff([ember({ from_id: "L", to_id: "P" }), ember({ from_id: "L", to_id: "P" })]),
      [],
      [{ qloo_entity_id: "P", explain_json: [{ entity_id: "R1", name: "", score: 0.9 }, { entity_id: "R2", name: "Second", score: 0.5 }, { entity_id: "R3", name: "", score: 0.4 }] }],
      ["R1", "R2", "R3"],
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ from: "R1", from_id: "R1", rated: null, runner_up: null, love_score: null, tied: false });
    expect(links[0]!.co).toEqual([{ name: "Second", score: 0.5 }, { name: "R3", score: 0.4 }]);
  });

  it("with explainability and a love: the runner-up falls back to the love's id and the rated map is consulted", () => {
    const links = emberThreads(diff([ember()]), [{ qloo_entity_id: "L", pleasure: 8 }], [{ qloo_entity_id: "P", explain_json: [{ entity_id: "L", name: "Lucy", score: 0.9 }, { entity_id: "LOVE", name: "", score: 0.1 }] }], ["L"]);
    expect(links[0]).toMatchObject({ from: "Lucy", rated: 8, runner_up: "LOVE", love_score: 0.1 });
  });

  it("with explainability and a love that outweighs every rating: no link", () => {
    expect(emberThreads(diff([ember()]), [], [{ qloo_entity_id: "P", explain_json: [{ entity_id: "L", name: "Lucy", score: 0.1 }, { entity_id: "LOVE", name: "Love", score: 0.9 }] }], ["L"])).toEqual([]);
    // none of the rated entities appears in the explainability at all
    expect(emberThreads(diff([ember()]), [], [{ qloo_entity_id: "P", explain_json: [{ entity_id: "LOVE", name: "Love", score: 0.9 }] }], ["L"])).toEqual([]);
  });

  it("stored diff without explainability: strongest stored link at its stored margin, top=false without margin is dropped", () => {
    const stored = emberThreads(diff([ember({ score: 0.2, margin: 0.001, top: false }), ember({ score: 0.9, margin: 0.2 }), ember({ to_id: "Q", to: "Other", top: false, from_id: "M", score: 0.3 }), ember({ to_id: "Z", to: "Zed", from_id: "M", score: 0.3 }), ember({ to_id: "Z", to: "Zed", from_id: "N", score: 0.1, top: false })]));
    expect(stored.map((l) => [l.to_id, l.margin, l.tied])).toEqual([["P", 0.2, false], ["Z", 0, true]]);
  });

  it("emberLabel: untied with no runner-up, tied with no runner-up, and an unrated source", () => {
    const base = { from: "Lucy", from_id: "L", to: "P", to_id: "P", score: 0.36, rated: null, margin: 0.1, runner_up: null, love_score: null, co: [], tied: false };
    expect(emberLabel(base)).toBe("← because of Lucy · 0.360");
    expect(emberLabel({ ...base, tied: true })).toBe("with Lucy · tied (0.360)");
    expect(emberLabel({ ...base, rated: 9, tied: true, runner_up: "Fleabag", love_score: 0.35 })).toBe("with Lucy, rated 9 · tied with Fleabag (0.360 vs 0.350)");
    expect(emberLabel({ ...base, rated: 9, runner_up: "Fleabag", love_score: 0.29, co: [{ name: "Big Thief", score: 0.35 }] })).toBe("← because of Lucy, rated 9 · 0.360, +0.070 over Fleabag (original love) · with Big Thief 0.350");
  });
});

describe("view: notices and coverage", () => {
  const kase = (o: Partial<{ max_meters: number; price_max: number; in_recovery: boolean; need_quiet: boolean; need_wheelchair: boolean }> = {}) => ({ max_meters: 1500, price_max: 2, in_recovery: false, need_quiet: false, need_wheelchair: false, ...o });
  const before = { id: "a", cards: [], empty_slots: [{ day_name: "thursday" as const, hour: 15, rung: "solo" as const, reason: "x" }] };
  const after = (t: { struck: number; refilled: number; ms: number } | null, cards: PlanDoc["cards"] = []) => ({ id: "b", cards, toggle: t ? { changed: {}, ...t } : null });

  it("loosening any one lever is reported as a retry", () => {
    const tight = kase({ in_recovery: true, need_quiet: true, need_wheelchair: true });
    const cases: [ReturnType<typeof kase>, ReturnType<typeof kase>][] = [
      [kase(), kase({ max_meters: 3000 })],
      [kase(), kase({ price_max: 3 })],
      [tight, { ...tight, in_recovery: false }],
      [tight, { ...tight, need_quiet: false }],
      [tight, { ...tight, need_wheelchair: false }],
    ];
    for (const [b, a] of cases) expect(toggleNotice(before, b, after({ struck: 0, refilled: 0, ms: 1000 }), a)).toMatch(/^Retried 1 empty outing/);
    const widened = toggleNotice(before, kase(), after({ struck: 0, refilled: 0, ms: 1000 }), kase({ max_meters: 3000 }));
    expect(widened).toBe("Retried 1 empty outing within 3 km: 0 filled, 1 still empty · 1.0 s. The verified cards stay as they were.");
    expect(toggleNotice(before, kase(), after({ struck: 0, refilled: 0, ms: 1000 }, [card()]), kase({ price_max: 3 }))).toContain("under the new setting: 1 filled, 0 still empty");
  });

  it("loosening with plural empties and with none", () => {
    const two = { ...before, empty_slots: [...before.empty_slots, { day_name: "friday" as const, hour: 15, rung: "social" as const, reason: "x" }, { day_name: "monday" as const, hour: 19, rung: "home" as const, reason: "x" }] };
    expect(toggleNotice(two, kase(), after({ struck: 0, refilled: 0, ms: 1000 }), kase({ max_meters: 3000 }))).toContain("Retried 2 empty outings within 3 km");
    expect(toggleNotice({ ...before, empty_slots: [] }, kase(), after({ struck: 0, refilled: 0, ms: 2000 }), kase({ max_meters: 3000 }))).toBe("Every placed outing still passes, and no outing was empty to retry (2.0 s).");
  });

  it("tightening reports struck / refilled counts with singular and plural forms", () => {
    const k = kase();
    const t = (struck: number, refilled: number) => toggleNotice(before, k, after({ struck, refilled, ms: 1000 }), k);
    expect(t(0, 0)).toBe("Every placed outing still passes the new constraint (1.0 s).");
    expect(t(0, 1)).toBe("1 outing moved to clinician review and refilled live · 1.0 s");
    expect(t(0, 2)).toBe("2 outings moved to clinician review and refilled live · 1.0 s");
    expect(t(1, 1)).toBe("1 outing struck in place and 1 slot refilled live · 1.0 s");
    expect(t(2, 2)).toBe("2 outings struck in place and 2 slots refilled live · 1.0 s");
    expect(toggleNotice(before, k, after(null), k)).toBe("No change to the week.");
  });

  it("coverageRefusal names every flag, singular and plural outings, and the one/many probe wording", () => {
    const c = { max_meters: 1500, price_max: 2, need_quiet: true, need_wheelchair: true, in_recovery: true };
    const one = coverageRefusal({ cards: [], empty_slots: [{ day_name: "thursday", hour: 15, rung: "solo", reason: "no candidate", relax: { quiet: 0, wheelchair: 0, price: 0 } }] }, c)!;
    expect(one.headline).toBe("Only 0 of 1 outing could be verified within 1.5 km (quiet, wheelchair entrance, alcohol-free, ≤$$), open at the slot.");
    expect(one.binding).toBe("Live check: relaxing quiet, wheelchair or budget alone would not fill it; the radius is the remaining lever.");
    const many = coverageRefusal(
      { cards: [], empty_slots: [{ day_name: "thursday", hour: 15, rung: "solo", reason: "r", relax: { quiet: 2 } }, { day_name: "friday", hour: 15, rung: "solo", reason: "r", relax: { quiet: 1 } }] },
      c,
    )!;
    expect(many.binding).toBe("Live check: without “quiet”, 2 of 2 empty outings would have a verified candidate.");
    expect(one.relax).toEqual([]);
    const two = coverageRefusal({ cards: [], empty_slots: ["thursday", "friday"].map((d) => ({ day_name: d as "thursday", hour: 15, rung: "solo" as const, reason: "r", relax: { quiet: 0 } })) }, c)!;
    expect(two.binding).toContain("would not fill them;");
    const single = coverageRefusal({ cards: [], empty_slots: [{ day_name: "thursday", hour: 15, rung: "solo", reason: "r", relax: { price: 3 } }] }, c)!;
    expect(single.binding).toContain("1 of 1 empty outing would");
  });
});

describe("view: printSheet", () => {
  it("home rows use the home type or the entity type; social and solo outings differ; a missing address has a fallback; same-day rows sort by hour", () => {
    const approved = { clinician_action: "approved" as const };
    const sheet = printSheet({
      status: "approved",
      cards: [
        card({ id: "a", ...approved, rung: "home", home_type: "podcast", hour: 19, entity_type: "urn:entity:podcast" }),
        card({ id: "b", ...approved, rung: "home", hour: 8, entity_type: "urn:entity:book" }),
        card({ id: "c", ...approved, rung: "social", hour: 14, address: "1 Main St" }),
        card({ id: "d", ...approved, rung: "solo", hour: 9 }),
        card({ id: "e", rung: "solo", hour: 10 }),
      ],
    });
    expect(sheet.printable).toBe(true);
    expect(sheet.rows.map((r) => [r.time, r.kind, r.where])).toEqual([
      ["08:00 · about 10 minutes", "book", "at home"],
      ["09:00", "outing on your own", "address on the clinician's sheet"],
      ["14:00", "outing with people around", "1 Main St"],
      ["19:00 · about 10 minutes", "podcast", "at home"],
    ]);
  });
});
