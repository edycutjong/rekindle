import { describe, expect, it } from "vitest";
import { applyConstraints, EMPTY_HISTORY, findOutings, MAX_REVIEW_PER_SLOT, type ToolContext, type WeekPlan } from "../lib/plan";
import { QlooClient, type QlooEntity } from "../lib/qloo";
import { MAYA } from "./replay";

/** a cafe open Thursday 08:00–20:00 within 300 m; extra tags make it ambiguous / refused */
const place = (id: string, extra: string[] = []): QlooEntity => ({
  entity_id: id,
  name: `Place ${id}`,
  tags: [{ id: "urn:tag:category:place:cafe" }, ...extra.map((x) => ({ id: x }))],
  query: { distance: 300 },
  properties: { hours: { thursday: [{ opens: "T08:00:00", closes: "T20:00:00", closed: false }] }, price_level: 1 },
});
const BAR_SEATING = "urn:tag:amenity:qloo:bar_seating";

function client(lists: QlooEntity[][], count: { n: number } = { n: 0 }) {
  let i = 0;
  return new QlooClient({
    apiKey: "test",
    sleep: async () => {},
    fetchImpl: async () => (count.n++, new Response(JSON.stringify({ success: true, results: { entities: lists[Math.min(i++, lists.length - 1)] } }), { status: 200, headers: { "content-type": "application/json" } })),
  });
}
const ctx = (q: QlooClient, inRecovery = true): ToolContext => ({ qloo: q, case: { ...MAYA, inRecovery }, history: EMPTY_HISTORY, used: new Set(), usedPlaces: new Set(), seen: new Set() });
const THU = { day: "thursday" as const, hour: 18, rung: "solo" as const };

describe("REVIEW state (clinician decides)", () => {
  it("an ambiguous venue Qloo ranked below the placed card is still surfaced for review, capped per slot, with no extra request", async () => {
    const calls = { n: 0 };
    const r = await findOutings(ctx(client([[place("A"), place("R1", [BAR_SEATING]), place("R2", [BAR_SEATING]), place("R3", [BAR_SEATING])]], calls)), THU);
    expect(r.card?.entity_id).toBe("A");
    expect(r.review.map((x) => x.entity_id)).toEqual(["R1", "R2"]);
    expect(r.review).toHaveLength(MAX_REVIEW_PER_SLOT);
    expect(r.review.every((x) => x.verdict === "REVIEW" && x.checks.some((k) => k.rule === "R-ALC" && k.verdict === "REVIEW"))).toBe(true);
    expect(calls.n).toBe(1);
  });

  it("not in recovery, bar seating is not ambiguous: nothing goes to review", async () => {
    const r = await findOutings(ctx(client([[place("A"), place("R1", [BAR_SEATING])]]), false), THU);
    expect(r.card?.entity_id).toBe("A");
    expect(r.review).toEqual([]);
  });

  it("toggling recovery ON moves a placed card that is only ambiguous to REVIEW (not a strike) and refills its slot", async () => {
    const before = await findOutings(ctx(client([[place("B", [BAR_SEATING])]]), false), THU);
    expect(before.card?.entity_id).toBe("B");
    const prev: WeekPlan = { week: 1, slots: [{ slot: THU, card: before.card }], refusals: [], review: [], calls: [] };
    const next = await applyConstraints(client([[place("C")]]), prev, { ...MAYA, inRecovery: true });
    expect(next.struck).toEqual([]);
    expect(next.refilled).toBe(1);
    expect(next.slots[0]!.card?.entity_id).toBe("C");
    expect(next.review.map((x) => [x.entity_id, x.verdict])).toEqual([["B", "REVIEW"]]);
    expect(next.review[0]!.checks.find((k) => k.rule === "R-ALC")?.verdict).toBe("REVIEW");
  });
});
