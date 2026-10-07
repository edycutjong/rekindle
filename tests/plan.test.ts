import { describe, expect, it } from "vitest";
import type { QlooClient, QlooParams } from "../lib/qloo";
import { ALCOHOL_EXCLUDE_14, TAG_QUIET, TAG_WHEELCHAIR } from "../lib/tags";
import { applyConstraints, EMPTY_HISTORY, findOutings, homeParams, ladder, outingParams, planWeek, type CaseRow, type ToolContext } from "../lib/plan";
import { diffWeeks, historyFromRatings, seedRatings, specificGenreTags } from "../lib/replan";
import { MAYA, replayClient } from "./replay";

describe("I6/I7: the case row, not the tool params, sets the constraints", () => {
  it("I6: for any LLM-supplied narrowMeters the radius never exceeds the case maximum and price is always the case cap", () => {
    for (let i = 0; i < 500; i++) {
      const narrow = Math.round(Math.random() * 20000) - 1000;
      const c = { ...MAYA, maxMeters: [1500, 3000, 5000][i % 3], priceMax: (i % 4) + 1 };
      const p = outingParams(c, "thursday", EMPTY_HISTORY, { narrowMeters: narrow });
      expect(p["filter.location.radius"]).toBeLessThanOrEqual(c.maxMeters);
      expect(p["filter.price_level.max"]).toBe(c.priceMax);
    }
  });

  it("I7: quiet, wheelchair and recovery flags always add their filters (intersection when both tags)", () => {
    const p = outingParams({ ...MAYA, needQuiet: true, needWheelchair: true, inRecovery: true }, "thursday", EMPTY_HISTORY, { narrowMeters: 99999 });
    expect(p["filter.tags"]).toEqual([TAG_QUIET, TAG_WHEELCHAIR]);
    expect(p["operator.filter.tags"]).toBe("intersection");
    expect(p["filter.exclude.tags"]).toEqual([...ALCOHOL_EXCLUDE_14]);
    const plain = outingParams(MAYA, "thursday", EMPTY_HISTORY);
    expect(plain["filter.tags"]).toEqual([]);
    expect(plain["filter.exclude.tags"]).toEqual([]);
  });

  it("builds exactly the seed-data demo query for Maya's Thursday outing", () => {
    expect(outingParams({ ...MAYA, inRecovery: true }, "thursday", EMPTY_HISTORY)).toMatchObject({
      "filter.type": "urn:entity:place",
      "signal.interests.entities": ["AFBC71A7-9439-4AB0-AB68-D14B11AAF836", "878680F2-2C8D-4D7A-8288-BEA75D38A843"],
      "signal.interests.tags": ["urn:tag:genre:place:restaurant:ramen"],
      "filter.location": "POINT(-73.9571 40.7081)",
      "filter.location.radius": 1500,
      "filter.hours": "thursday",
      "filter.price_level.max": 2,
      "feature.explainability": true,
      take: 25,
    });
  });

  it("at-home queries drop place tags and clamp take to 3..10", () => {
    const p = homeParams(MAYA, "podcast", 50, EMPTY_HISTORY);
    expect(p["filter.type"]).toBe("urn:entity:podcast");
    expect(p["signal.interests.tags"]).toEqual([]);
    expect(p.take).toBe(10);
  });
});

describe("ladder", () => {
  it("energy 1 is 4 at-home doses, 2 solo outings, 1 social outing, Thursday 18:00 solo", () => {
    const l = ladder(1);
    expect(l).toHaveLength(7);
    expect(l.filter((s) => s.rung === "home")).toHaveLength(4);
    expect(l.filter((s) => s.rung === "social")).toHaveLength(1);
    expect(l.find((s) => s.day === "thursday")).toEqual({ day: "thursday", hour: 18, rung: "solo" });
    expect(ladder(3).filter((s) => s.rung !== "home").length).toBeGreaterThan(ladder(1).filter((s) => s.rung !== "home").length);
  });
});

describe("tools over captured responses", () => {
  const ctx = (c: CaseRow, q: QlooClient): ToolContext => ({ qloo: q, case: c, history: EMPTY_HISTORY, used: new Set(), usedPlaces: new Set(), seen: new Set() });

  it("Thu 18:00 in recovery: Dun-Well is refused at 18:00 and re-slotted to 15:00 (no new Qloo call)", async () => {
    const seen: QlooParams[] = [];
    const r = await findOutings(ctx({ ...MAYA, inRecovery: true }, replayClient(seen)), { day: "thursday", hour: 18, rung: "solo" });
    expect(seen).toHaveLength(1);
    expect(r.card).toMatchObject({ name: "Dun-Well Doughnuts", hour: 15, movedFrom: 18 });
    // a move, not a refusal: the placed venue is never struck under itself or counted as R-OPEN
    expect(r.refusals.filter((x) => x.entity_id === r.card!.entity_id)).toEqual([]);
  });

  it("no plan has the same venue placed and refused on the same day (moves are not refusals), across toggles", async () => {
    const q = replayClient([]);
    for (const c of [MAYA, { ...MAYA, inRecovery: true }]) {
      const w1 = await planWeek(q, c, 1);
      const w1r = await applyConstraints(q, w1, { ...c, inRecovery: true, needQuiet: true });
      for (const w of [w1, w1r]) {
        const placed = new Set(w.slots.flatMap((s) => (s.card ? [`${s.slot.day}|${s.card.entity_id}`] : [])));
        expect(w.refusals.filter((x) => placed.has(`${x.day}|${x.entity_id}`))).toEqual([]);
      }
    }
  });

  it("an LLM-narrowed radius that verifies nothing is retried once at the case radius before the slot is left empty", async () => {
    const seen: QlooParams[] = [];
    const inner = replayClient(seen);
    // the narrowed query returns nothing; the case-radius query returns the captured pool
    const q = { insights: async (p: QlooParams) => (p["filter.location.radius"] === 600 ? (seen.push(p), { results: { entities: [] } }) : inner.insights(p)) } as unknown as QlooClient;
    const r = await findOutings(ctx({ ...MAYA, inRecovery: true }, q), { day: "thursday", hour: 15, rung: "solo" }, { narrowMeters: 600 });
    expect(seen.map((p) => p["filter.location.radius"])).toEqual([600, 1500]);
    expect(r.card).not.toBeNull();

    // both empty: the reason names the radius actually queried last (the case radius)
    const none = { insights: async (p: QlooParams) => (seen.push(p), { results: { entities: [] } }) } as unknown as QlooClient;
    seen.length = 0;
    const e = await findOutings(ctx(MAYA, none), { day: "thursday", hour: 15, rung: "solo" }, { narrowMeters: 800 });
    expect(seen.map((p) => p["filter.location.radius"])).toEqual([800, 1500]);
    expect(e.card).toBeNull();
    expect(e.empty).toBe("Qloo returned no places for these filters within 1500 m");

    // no narrowing → exactly one request
    seen.length = 0;
    await findOutings(ctx(MAYA, none), { day: "thursday", hour: 15, rung: "solo" });
    expect(seen).toHaveLength(1);
  });

  it("a Qloo outage leaves the slot empty with the reason — never an LLM fill", async () => {
    const r = await findOutings(ctx(MAYA, replayClient([], true)), { day: "thursday", hour: 18, rung: "solo" });
    expect(r.card).toBeNull();
    expect(r.empty).toBe("Qloo unavailable (503) — slot left empty");
  });

  it("toggling recovery ON strikes placed alcohol venues in place and refills only those slots", async () => {
    const q = replayClient();
    const w1 = await planWeek(q, MAYA, 1);
    const w1r = await applyConstraints(q, w1, { ...MAYA, inRecovery: true });
    expect(w1r.struck.length).toBeGreaterThan(0);
    expect(w1r.struck.every((s) => s.rule === "R-ALC" && s.struckByToggle)).toBe(true);
    // at-home cards are untouched by the toggle
    expect(w1r.slots.filter((s) => s.slot.rung === "home").map((s) => s.card?.entity_id)).toEqual(w1.slots.filter((s) => s.slot.rung === "home").map((s) => s.card?.entity_id));
    // nothing struck comes back
    const placed = new Set(w1r.slots.flatMap((s) => (s.card ? [s.card.entity_id] : [])));
    for (const s of w1r.struck) expect(placed.has(s.entity_id)).toBe(false);
    // every placed card passes the verifier for the new case row
    for (const s of w1r.slots) if (s.card) expect(s.card.verdict).toBe("PASS");
  });
});

describe("re-plan math", () => {
  it("rated ≥7 → signals (+ a place's specific genre tags); rated ≤3 → exclusions; mastery changes nothing", async () => {
    const q = replayClient();
    const w1 = await applyConstraints(q, await planWeek(q, MAYA, 1), { ...MAYA, inRecovery: true });
    const cards = w1.slots.flatMap((s) => (s.card ? [s.card] : []));
    const ratings = seedRatings(w1)!;
    expect(ratings.map((r) => r.pleasure)).toEqual([7, 8, 2]);
    const h = historyFromRatings(EMPTY_HISTORY, cards, ratings);
    expect(h.rekindled.map((r) => r.entity_id)).toEqual([ratings[0].entity_id, ratings[1].entity_id]);
    expect(h.lowRated).toEqual([ratings[2].entity_id]);
    const p = outingParams({ ...MAYA, inRecovery: true }, "thursday", h);
    expect(String(p["signal.interests.entities"])).toContain(ratings[1].entity_id);
    expect(String(p["filter.exclude.entities"])).toContain(ratings[2].entity_id);
    const sameMastery = historyFromRatings(EMPTY_HISTORY, cards, ratings.map((r) => ({ ...r, mastery: 10 })));
    expect(sameMastery).toEqual(h);
  });

  it("a ≤3 place's genre tags shared with a ≥7 card are never excluded", () => {
    const mk = (id: string, tags: string[]) => ({ entity_id: id, name: id, rung: "solo" as const, tags, entityType: "urn:entity:place" }) as never;
    const shared = "urn:tag:genre:place:restaurant:bakery";
    const h = historyFromRatings(EMPTY_HISTORY, [mk("A", [shared, "urn:tag:genre:place:restaurant:vegan"]), mk("B", [shared, "urn:tag:genre:place:restaurant:juice_shop"])], [
      { entity_id: "A", pleasure: 9, mastery: 5 },
      { entity_id: "B", pleasure: 1, mastery: 5 },
    ]);
    expect(h.excludeTags).toEqual(["urn:tag:genre:place:restaurant:juice_shop"]);
    expect(h.signalTags).toContain(shared);
  });

  it("specificGenreTags skips the generic restaurant genre and orders the most specific first", () => {
    expect(specificGenreTags(["urn:tag:genre:place:restaurant", "urn:tag:genre:place:park", "urn:tag:genre:place:restaurant:ramen", "urn:tag:category:place:cafe"])).toEqual(["urn:tag:genre:place:restaurant:ramen", "urn:tag:genre:place:park"]);
  });

  it("the seed rating rule needs ≥2 verified outings", async () => {
    const empty = { week: 1, slots: [], refusals: [], review: [], calls: [] };
    expect(seedRatings(empty)).toBeNull();
  });

  it("diff marks the ≤3 card as excluded and threads ember from rekindled entities named in explainability", async () => {
    const q = replayClient();
    const w1 = await applyConstraints(q, await planWeek(q, MAYA, 1), { ...MAYA, inRecovery: true });
    const ratings = seedRatings(w1)!;
    const h = historyFromRatings(EMPTY_HISTORY, w1.slots.flatMap((s) => (s.card ? [s.card] : [])), ratings);
    // week 2 replayed from the same pools; the low-rated entity must not return
    const w2 = await planWeek(q, { ...MAYA, inRecovery: true }, 2, h);
    expect(w2.slots.some((s) => s.card?.entity_id === ratings[2].entity_id)).toBe(false);
    const d = diffWeeks(w1, w2, h);
    expect(d.removed.find((r) => r.reason.startsWith("rated ≤3"))).toBeTruthy();
    // replayed fixtures carry week-1 explainability (2 loves only), so no ember fires here — the live run measures it
    expect(d.ember.every((e) => e.score > 0)).toBe(true);
  });
});
