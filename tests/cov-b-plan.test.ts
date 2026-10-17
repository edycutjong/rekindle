import { describe, expect, it } from "vitest";
import { QlooError, type InsightsResponse, type QlooClient, type QlooEntity, type QlooParams, type WeekHours } from "../lib/qloo";
import { applyConstraints, dayIndex, diagnoseEmpty, EMPTY_HISTORY, excludedIds, findAtHome, findOutings, homeParams, ladder, outingParams, placeSocial, planWeek, recheckKept, type Card, type CaseRow, type PlanHistory, type SlotSpec, type ToolContext, type WeekPlan } from "../lib/plan";
import { ALCOHOL_EXCLUDE_14 } from "../lib/tags";
import { DAYS } from "../lib/verify";
import { MAYA } from "./replay";

const hoursAll = (closes = "T22:00:00"): WeekHours => Object.fromEntries(DAYS.map((d) => [d, [{ opens: "T08:00:00", closes }]]));
const REVIEW_TAG = "urn:tag:amenity:qloo:bar_seating";

const place = (id: string, o: Partial<QlooEntity> = {}): QlooEntity => ({
  entity_id: id,
  name: id,
  tags: [{ id: "urn:tag:category:place:bakery" }],
  properties: { hours: hoursAll(), price_level: 1, address: "1 Main St" },
  location: { lat: MAYA.lat, lon: MAYA.lon },
  query: { distance: 300, affinity: 0.5 },
  ...o,
});
const noDistance = (id: string) => place(id, { query: { affinity: 0.4 } });
const reviewable = (id: string) => place(id, { tags: [{ id: "urn:tag:category:place:bakery" }, { id: REVIEW_TAG }] });
const media = (id: string, o: Partial<QlooEntity> = {}): QlooEntity => ({ entity_id: id, name: id, query: { affinity: 0.5 }, ...o });

type Insights = (p: QlooParams) => InsightsResponse | Promise<InsightsResponse>;
const fake = (insights: Insights, entities?: (ids: string[]) => { results: QlooEntity[] } | Promise<{ results: QlooEntity[] }>) => ({ insights: async (p: QlooParams) => insights(p), ...(entities ? { entities: async (ids: string[]) => entities(ids) } : {}) }) as unknown as QlooClient;
const list = (...entities: QlooEntity[]): InsightsResponse => ({ results: { entities } });
const ctx = (c: CaseRow, q: QlooClient, o: Partial<ToolContext> = {}): ToolContext => ({ qloo: q, case: c, history: EMPTY_HISTORY, used: new Set(), usedPlaces: new Set(), seen: new Set(), ...o });
const SOLO: SlotSpec = { day: "thursday", hour: 18, rung: "solo" };
const HOME: SlotSpec = { day: "monday", hour: 19, rung: "home", homeType: "artist" };
const RECOVERY = { ...MAYA, inRecovery: true };
const noStruck: PlanHistory = { rekindled: [], lowRated: ["LOW"], excludeTags: [], signalTags: [] };

describe("history without a struck list", () => {
  it("exclusions are just the low-rated ids", () => {
    expect(excludedIds(noStruck)).toEqual(["LOW"]);
    expect(homeParams(MAYA, "artist", 5, noStruck)["filter.exclude.entities"]).toEqual(["LOW"]);
    expect(outingParams(MAYA, "monday", noStruck)["filter.exclude.entities"]).toEqual(["LOW"]);
  });

  it("findAtHome refuses a low-rated entity from the same history and says so", async () => {
    const r = await findAtHome(ctx(MAYA, fake(() => list(media("LOW"))), { history: noStruck }), HOME, "artist");
    expect(r).toMatchObject({ card: null, empty: "no verified artist for these loves", returned: 1 });
  });

  it("a response with no results block is an empty list, not an error", async () => {
    const r = await findAtHome(ctx(MAYA, fake(() => ({}) as InsightsResponse)), HOME, "artist");
    expect(r).toMatchObject({ card: null, returned: 0, empty: "no verified artist for these loves" });
  });
});

describe("ladder energy 2", () => {
  it("has solo outings on Wednesday, Thursday and Saturday and one social Sunday", () => {
    expect(ladder(2).map((s) => `${s.day}:${s.rung}`)).toEqual(["monday:home", "tuesday:home", "wednesday:solo", "thursday:solo", "friday:home", "saturday:solo", "sunday:social"]);
  });
  it("dayIndex follows Monday-first order", () => {
    expect([dayIndex("monday"), dayIndex("sunday")]).toEqual([0, 6]);
  });
});

describe("card construction from Qloo entities", () => {
  it("tags accept id or tag_id and drop empty ones; the why line names loves and falls back to the entity id", async () => {
    const e = media("M1", {
      tags: [{ id: "A" }, { tag_id: "B" }, {}],
      query: { affinity: 0.7, explainability: { "signal.interests.entities": [{ entity_id: MAYA.loves[0]!.qlooId, score: 0.6 }, { entity_id: "UNKNOWN", score: 0.4 }] } },
    });
    const r = await findAtHome(ctx(MAYA, fake(() => list(e))), HOME, "artist");
    expect(r.card).toMatchObject({ tags: ["A", "B"], affinity: 0.7 });
    expect(r.card!.why).toEqual([{ entity_id: MAYA.loves[0]!.qlooId, name: "Phoebe Bridgers", score: 0.6 }, { entity_id: "UNKNOWN", name: "UNKNOWN", score: 0.4 }]);
    const bare = await findAtHome(ctx(MAYA, fake(() => list({ entity_id: "M2", name: "M2" }))), HOME, "artist");
    expect(bare.card).toMatchObject({ tags: [], why: [], entityType: "", affinity: 0 });
  });
});

describe("findOutings", () => {
  it("after a pass, the rest of the answer is screened for REVIEW: used and distance-less candidates are skipped, ambiguous ones are held", async () => {
    const c = ctx(RECOVERY, fake(() => list(place("GOOD"), place("USED"), noDistance("NODIST"), reviewable("HOLD"))), { used: new Set(["USED"]) });
    const r = await findOutings(c, SOLO);
    expect(r.card?.entity_id).toBe("GOOD");
    expect(r.review.map((x) => x.entity_id)).toEqual(["HOLD"]);
    expect(r.review[0]).toMatchObject({ verdict: "REVIEW" });
  });

  it("an ambiguous candidate met before any pass is held for review, a candidate without a distance is refused, and the next one is placed", async () => {
    const r = await findOutings(ctx(RECOVERY, fake(() => list(reviewable("HOLD"), noDistance("NODIST"), place("GOOD")))), SOLO);
    expect(r.card?.entity_id).toBe("GOOD");
    expect(r.review.map((x) => x.entity_id)).toEqual(["HOLD"]);
    expect(r.refusals).toContainEqual(expect.objectContaining({ entity_id: "NODIST", rule: "R-NEAR", detail: "distance unknown" }));
    expect(r.refusals.some((x) => x.entity_id === "HOLD")).toBe(false);
  });

  it("works without a usedPlaces set on the context", async () => {
    const seen: QlooParams[] = [];
    const c = ctx(MAYA, fake((p) => (seen.push(p), list(place("GOOD")))));
    delete c.usedPlaces;
    expect((await findOutings(c, SOLO)).card?.entity_id).toBe("GOOD");
    expect(seen[0]!["filter.exclude.entities"]).toEqual([]);
  });

  it("an outing closed at the slot is moved to the latest open hour with no refusal recorded", async () => {
    const closing = place("EARLY", { properties: { hours: hoursAll("T17:00:00"), price_level: 1 } });
    const r = await findOutings(ctx(MAYA, fake(() => list(closing))), SOLO);
    expect(r.card).toMatchObject({ entity_id: "EARLY", hour: 15, movedFrom: 18 });
    expect(r.refusals).toEqual([]);
  });

  it.each([
    ["geohash cell, empty answer", { geohash: "dr5r" }, [] as QlooEntity[], "Qloo returned no places for these filters"],
    ["geohash cell, everything refused", { geohash: "dr5r" }, [noDistance("X")], "no candidate passed all rules (1 checked)"],
    ["case radius, everything refused", {}, [noDistance("X")], "no candidate passed all rules (1 checked within 1500 m)"],
  ])("empty reason: %s", async (_n, opts, entities, want) => {
    const r = await findOutings(ctx(MAYA, fake(() => list(...entities))), SOLO, opts);
    expect(r).toMatchObject({ card: null, empty: want });
  });
});

describe("diagnoseEmpty", () => {
  it("a Qloo failure while probing is no diagnosis", async () => {
    const q = fake(() => {
      throw new QlooError("down", 503, "/v2/insights");
    });
    expect(await diagnoseEmpty(ctx({ ...MAYA, needQuiet: true }, q), SOLO)).toBeNull();
  });

  it("wheelchair-only: relaxing it is reported, the used set filters the probe, and no price key at the top budget", async () => {
    const seen: QlooParams[] = [];
    const c = ctx({ ...MAYA, needWheelchair: true, priceMax: 4 }, fake((p) => (seen.push(p), list(place("A"), place("B")))), { used: new Set(["B"]) });
    delete c.usedPlaces;
    expect(await diagnoseEmpty(c, SOLO)).toEqual({ wheelchair: 1 });
    expect(seen).toHaveLength(1);
  });
});

describe("placeSocial", () => {
  const cell = (geohash: string | undefined, d: number, affinity: number) => ({ location: { latitude: MAYA.lat + d, longitude: MAYA.lon, ...(geohash ? { geohash } : {}) }, query: { affinity } });
  const social: SlotSpec = { day: "sunday", hour: 14, rung: "social" };
  const heat = (cells: ReturnType<typeof cell>[]): InsightsResponse => ({ results: { heatmap: cells as never } });
  const centers = (c0: number) => `POINT(${MAYA.lon} ${MAYA.lat + c0})`;

  it.each([
    ["the second cell's own geohash", "g1", "g1"],
    ["the top cell's geohash when the cell that found the place has none", undefined, "g0"],
  ])("a place found in a fallback ring is labelled with %s", async (_n, g1, want) => {
    const q = fake((p) => {
      if (p["filter.type"] === "urn:heatmap") return heat([cell("g0", 0.001, 0.9), cell(g1, 0.002, 0.8)]);
      // only the ring around the second cell holds a place
      return p["filter.location"] === centers(0.002) ? list(place("RING")) : list();
    });
    const r = await placeSocial(ctx(MAYA, q), social);
    expect(r.card).toMatchObject({ entity_id: "RING", geohash: want });
    expect(r.cell).toBe(want);
  });

  it("a heatmap request that fails leaves the slot empty with the outage reason", async () => {
    const q = fake(() => {
      throw new QlooError("down", 502, "/v2/insights");
    });
    expect(await placeSocial(ctx(MAYA, q), social)).toMatchObject({ card: null, returned: 0, empty: "Qloo unavailable (502) — slot left empty" });
  });

  it("when no ring holds a place the reason is the last attempt's", async () => {
    const q = fake((p) => (p["filter.type"] === "urn:heatmap" ? heat([cell("g0", 0.001, 0.9)]) : list()));
    const r = await placeSocial(ctx(MAYA, q), social);
    expect(r).toMatchObject({ card: null, cell: "g0", empty: "Qloo returned no places for these filters" });
  });
});

describe("Qloo outages are worded by what failed", () => {
  const down = (e: Error) => fake(() => {
    throw e;
  });
  it.each([
    ["deadline", new QlooError("Qloo /v2/insights failed: run deadline reached", 0, "/v2/insights"), "Qloo unavailable (time limit) — slot left empty"],
    ["no status", new QlooError("boom", 0, "/v2/insights"), "Qloo unavailable (network) — slot left empty"],
    ["http status", new QlooError("boom", 503, "/v2/insights"), "Qloo unavailable (503) — slot left empty"],
    ["not a QlooError", new Error("boom"), "Qloo unavailable — slot left empty"],
  ])("%s", async (_n, err, want) => {
    expect((await findAtHome(ctx(MAYA, down(err)), HOME, "artist")).empty).toBe(want);
  });
});

describe("recheckKept", () => {
  const outing = (o: Partial<Card> = {}): Card => ({ slot: { day: "thursday", hour: 18, rung: "solo" }, hour: 15, rung: "solo", entity_id: "KEPT", name: "Kept", entityType: "urn:entity:place", affinity: 0.8, tags: [], why: [{ entity_id: "L", name: "Love", score: 0.5 }], verdict: "PASS", checks: [], ...o });
  const home = (): Card => outing({ rung: "home", slot: HOME, hour: 19, entityType: "urn:entity:artist" });
  const q = (entities: QlooEntity[] | undefined) => fake(() => list(), () => ({ results: entities }) as { results: QlooEntity[] });
  const throws = (e: Error) => fake(() => list(), () => {
    throw e;
  });

  it.each([
    ["QlooError with a status", new QlooError("x", 503, "/entities"), "re-check unavailable (503)"],
    ["QlooError without one", new QlooError("x", 0, "/entities"), "re-check unavailable (network)"],
    ["anything else", new Error("x"), "re-check unavailable (error)"],
  ])("a failing lookup: %s", async (_n, err, detail) => {
    expect(await recheckKept(throws(err), MAYA, EMPTY_HISTORY, outing())).toEqual({ card: null, detail });
  });

  it("an entity Qloo no longer returns, or an answer with no results, cannot be kept", async () => {
    expect(await recheckKept(q([place("OTHER")]), MAYA, EMPTY_HISTORY, outing())).toEqual({ card: null, detail: "Qloo /entities no longer returns it" });
    expect(await recheckKept(q(undefined), MAYA, EMPTY_HISTORY, outing())).toEqual({ card: null, detail: "Qloo /entities no longer returns it" });
  });

  it("a home dose is kept when it still passes and refused when the history now strikes it", async () => {
    const ok = await recheckKept(q([media("KEPT")]), MAYA, EMPTY_HISTORY, home());
    expect(ok.card).toMatchObject({ entity_id: "KEPT", verdict: "PASS" });
    expect(ok.detail).toBe("kept, re-checked live with Qloo /entities");
    const struck = await recheckKept(q([media("KEPT")]), MAYA, { ...EMPTY_HISTORY, lowRated: ["KEPT"] }, home());
    expect(struck).toEqual({ card: null, detail: "re-check failed: R-HIST rated ≤3 before" });
  });

  it.each([
    ["lat/lon", { lat: MAYA.lat, lon: MAYA.lon }],
    ["latitude/longitude", { latitude: MAYA.lat, longitude: MAYA.lon }],
  ])("an outing with %s coordinates is kept with its week-1 why line, move and cell", async (_n, location) => {
    const e = place("KEPT", { location: location as never, query: { affinity: 0.8 } });
    const r = await recheckKept(q([e]), MAYA, EMPTY_HISTORY, outing({ movedFrom: 18, geohash: "dr5r" }));
    expect(r.detail).toBe("kept, re-checked live for thu 15:00 with Qloo /entities");
    expect(r.card).toMatchObject({ entity_id: "KEPT", hour: 15, movedFrom: 18, geohash: "dr5r", why: [{ entity_id: "L", name: "Love", score: 0.5 }] });
    expect(r.card!.distance_m).toBe(0);
  });

  it("an outing with no coordinates has no distance and fails R-NEAR", async () => {
    const e = { ...place("KEPT"), location: undefined } as unknown as QlooEntity;
    delete (e as { query?: unknown }).query;
    const r = await recheckKept(q([e]), MAYA, EMPTY_HISTORY, outing());
    expect(r.card).toBeNull();
    expect(r.detail).toBe("re-check for thu 15:00 failed: R-NEAR distance unknown");
  });

  it("a kept card without a move or a cell carries neither", async () => {
    const r = await recheckKept(q([place("KEPT")]), MAYA, EMPTY_HISTORY, outing({ hour: 18 }));
    expect(r.card).not.toHaveProperty("movedFrom");
    expect(r.card).not.toHaveProperty("geohash");
  });
});

describe("planWeek and applyConstraints with empty answers", () => {
  const nothing = fake(() => list());

  it("a week Qloo cannot fill has every slot empty with its reason", async () => {
    const w = await planWeek(nothing, MAYA, 1);
    expect(w.slots).toHaveLength(7);
    expect(w.slots.every((s) => s.card === null && typeof s.empty === "string")).toBe(true);
  });

  const placedWeek = (card: Partial<Card>, extra: WeekPlan["slots"] = []): WeekPlan => ({
    week: 1,
    slots: [{ slot: SOLO, card: { slot: SOLO, hour: 18, rung: "solo", entity_id: "BAR", name: "Corner Spot", entityType: "urn:entity:place", affinity: 0.5, distance_m: 300, tags: [ALCOHOL_EXCLUDE_14[0]!], why: [], verdict: "PASS", checks: [], ...card } }, ...extra],
    refusals: [],
    review: [],
    calls: [],
  });

  it("a struck outing whose refill finds nothing leaves the slot empty with the reason", async () => {
    const out = await applyConstraints(nothing, placedWeek({}), RECOVERY);
    expect(out.struck.map((s) => s.entity_id)).toEqual(["BAR"]);
    expect(out.slots[0]).toMatchObject({ card: null, empty: "Qloo returned no places for these filters within 1500 m" });
    expect(out.refilled).toBe(1);
  });

  it.each([
    ["a clean candidate", [place("CLEAN")], { card: { entity_id: "CLEAN" } }],
    ["nothing", [] as QlooEntity[], { card: null, empty: "Qloo returned no places for these filters within 1500 m" }],
  ])("an outing that is only ambiguous under the new constraint moves to review, keeps its other checks, and its slot is refilled with %s", async (_n, answer, slot) => {
    const checks = [{ rule: "R-ID" as const, verdict: "PASS" as const, detail: "BAR" }, { rule: "R-ALC" as const, verdict: "PASS" as const, detail: "not in recovery" }];
    const out = await applyConstraints(fake(() => list(...answer)), placedWeek({ tags: [REVIEW_TAG], checks }), RECOVERY);
    expect(out.struck).toEqual([]);
    expect(out.review.map((x) => [x.entity_id, x.verdict, x.checks.map((c) => `${c.rule}:${c.verdict}`)])).toEqual([["BAR", "REVIEW", ["R-ID:PASS", "R-ALC:REVIEW"]]]);
    expect(out.slots[0]).toMatchObject(slot);
    expect(out.refilled).toBe(1);
  });

  it("a social outing that is only ambiguous under the new constraint is refilled through the heatmap route", async () => {
    const social: SlotSpec = { day: "sunday", hour: 14, rung: "social" };
    const prev = placedWeek({ tags: [REVIEW_TAG], slot: social, hour: 14, rung: "social" });
    prev.slots[0]!.slot = social;
    const out = await applyConstraints(fake(() => ({ results: {} })), prev, RECOVERY);
    expect(out.review.map((x) => x.entity_id)).toEqual(["BAR"]);
    expect(out.slots[0]).toMatchObject({ card: null, empty: "no heatmap cell inside the radius" });
    expect(out.refilled).toBe(1);
  });

  it("loosening retries empty solo and social slots; a filled one carries its card, an unfilled one its reason", async () => {
    const q = fake((p) => (p["filter.type"] === "urn:entity:place" ? list(place("FRESH")) : heatless()));
    const heatless = (): InsightsResponse => ({ results: {} });
    const prev: WeekPlan = { week: 1, slots: [{ slot: SOLO, card: null, empty: "no candidate" }, { slot: { day: "sunday", hour: 14, rung: "social" }, card: null, empty: "no candidate" }], refusals: [], review: [], calls: [] };
    const out = await applyConstraints(q, prev, MAYA, EMPTY_HISTORY, { refillEmpty: true });
    expect(out.refilled).toBe(2);
    expect(out.slots[0]).toMatchObject({ card: { entity_id: "FRESH" } });
    expect(out.slots[1]).toMatchObject({ card: null, empty: "no heatmap cell inside the radius" });
    expect(out.slots[1]).not.toHaveProperty("relax", undefined);
  });

  it("an empty outing keeps no stale diagnosis once nothing optional is left to relax", async () => {
    const stale: WeekPlan = { week: 1, slots: [{ slot: SOLO, card: null, empty: "no candidate", relax: { quiet: 2 } }], refusals: [], review: [], calls: [] };
    const out = await applyConstraints(nothing, stale, { ...MAYA, priceMax: 4 });
    expect(out.slots[0]).toEqual({ slot: SOLO, card: null, empty: "no candidate" });
    expect(out.slots[0]).not.toHaveProperty("relax");
  });
});
