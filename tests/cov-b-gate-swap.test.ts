import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, ToolResult } from "../lib/plan";

// The swap path maps whatever the slot tool returns onto the plan. The tools themselves are covered by tests/plan.test.ts,
// so here they are stubbed to return crafted results (including shapes the live tools can no longer produce, e.g. a
// refusal that carries `movedTo`).
vi.mock("../lib/plan", async (orig) => ({ ...(await orig<typeof import("../lib/plan")>()), findAtHome: vi.fn(), findOutings: vi.fn(), placeSocial: vi.fn() }));

import { actOnCard } from "../lib/gate";
import * as planLib from "../lib/plan";
import { CardDoc, CaseDoc, MemoryStore, PlanDoc } from "../lib/store";
import type { QlooClient } from "../lib/qloo";

const findAtHome = vi.mocked(planLib.findAtHome);
const findOutings = vi.mocked(planLib.findOutings);
const placeSocial = vi.mocked(planLib.placeSocial);

const CASE_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";

const caseDoc = (): CaseDoc =>
  CaseDoc.parse({
    id: CASE_ID,
    label: "Test",
    created_at: "2026-10-01T00:00:00Z",
    point_wkt: "POINT(-73.9571 40.7081)",
    lon: -73.9571,
    lat: 40.7081,
    energy: 1,
    price_max: 2,
    max_meters: 1500,
    in_recovery: false,
    need_quiet: false,
    need_wheelchair: false,
    loves: [{ id: "l1", text: "ramen", qloo_id: "urn:tag:genre:place:restaurant:ramen", qloo_kind: "tag" }],
  });

const cardDoc = (o: Partial<CardDoc>): CardDoc =>
  CardDoc.parse({
    id: "card-x",
    plan_id: PLAN_ID,
    day: 0,
    day_name: "monday",
    hour: 19,
    slot_hour: 19,
    rung: "home",
    qloo_entity_id: "E-x",
    name: "Thing",
    entity_type: "urn:entity:artist",
    affinity: 0.5,
    explain_json: [],
    tags: [],
    checks: [],
    verdict: "PASS",
    ...o,
  });

const planDoc = (cards: CardDoc[]): PlanDoc =>
  PlanDoc.parse({
    id: PLAN_ID,
    case_id: CASE_ID,
    week: 1,
    status: "draft",
    created_at: "2026-10-01T00:00:00Z",
    llm_provider: null,
    llm_model: null,
    qloo_calls: 0,
    latency_ms: 0,
    history: { rekindled: [], lowRated: [], excludeTags: [], signalTags: [] },
    cards,
    empty_slots: [],
    refusals: [],
    review: [],
    dropped: [],
  });

const newCard = (o: Partial<Card> = {}): Card => ({
  slot: { day: "monday", hour: 19, rung: "home" },
  hour: 19,
  rung: "home",
  entity_id: "E-new",
  name: "Replacement",
  entityType: "urn:entity:artist",
  affinity: 0.7,
  tags: [],
  why: [],
  verdict: "PASS",
  checks: [],
  ...o,
});

const result = (o: Partial<ToolResult> = {}): ToolResult => ({ card: null, refusals: [], review: [], returned: 0, ...o });

const noQloo = (() => ({}) as unknown as QlooClient) as never;
const log = { path: "/v2/insights", params: { a: "b" }, status: 200, ms: 3, n_results: 2, attempts: 1, at: "2026-10-02T00:00:00Z" };
/** a Qloo factory whose client "made" one call while the tool ran */
const oneCall = ((cb: (l: typeof log) => void) => {
  cb(log);
  return {} as unknown as QlooClient;
}) as never;

async function setup(cards: CardDoc[], withCalls = false) {
  const store = new MemoryStore();
  await store.putCase(caseDoc());
  await store.putPlan(planDoc(cards));
  if (withCalls) await store.putCalls({ plan_id: PLAN_ID, calls: [{ path: "/old", params_json: {}, status: 200, ms: 1, n_results: 1, at: "2026-10-01T00:00:00Z" }] });
  return store;
}

afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  findAtHome.mockReset();
  findOutings.mockReset();
  placeSocial.mockReset();
});

describe("clinician swap: which tool runs and with what", () => {
  const table: [string, Partial<CardDoc>, "findAtHome" | "findOutings" | "placeSocial", string | undefined][] = [
    ["home card with a stored home type", { rung: "home", home_type: "podcast", entity_type: "urn:entity:book" }, "findAtHome", "podcast"],
    ["home card without a home type derives it from the entity type", { rung: "home", entity_type: "urn:entity:tv_show" }, "findAtHome", "tv_show"],
    ["home card with an empty entity type falls back to artist", { rung: "home", entity_type: "urn:entity:" }, "findAtHome", "artist"],
    ["solo card", { rung: "solo", entity_type: "urn:entity:place", day_name: "thursday", hour: 18, slot_hour: 18 }, "findOutings", undefined],
    ["social card", { rung: "social", entity_type: "urn:entity:place", day_name: "sunday", hour: 14, slot_hour: 14 }, "placeSocial", undefined],
  ];
  it.each(table)("%s", async (_n, o, tool, homeType) => {
    const store = await setup([cardDoc({ id: "c1", ...o })]);
    for (const f of [findAtHome, findOutings, placeSocial]) f.mockResolvedValue(result({ empty: "nothing" }) as never);
    const r = await actOnCard({ store, planId: PLAN_ID, cardId: "c1", action: "swap", qloo: noQloo });
    expect(r.swap).toMatchObject({ found: false, calls: 0 });
    const calls = { findAtHome, findOutings, placeSocial };
    for (const [name, fn] of Object.entries(calls)) expect(fn).toHaveBeenCalledTimes(name === tool ? 1 : 0);
    if (homeType) expect(findAtHome.mock.calls[0]![2]).toBe(homeType);
    // the slot handed to the tool is the card's own, and every entity on the sheet is excluded
    const ctx = calls[tool].mock.calls[0]![0];
    expect(ctx.used.has("E-x")).toBe(true);
    expect(calls[tool].mock.calls[0]![1]).toMatchObject({ day: o.day_name ?? "monday", rung: o.rung });
    expect(ctx.usedPlaces?.size).toBe(o.rung === "home" ? 0 : 1);
  });
});

describe("clinician swap: what is stored", () => {
  it("a found replacement replaces the card in place; refusals, review boxes and the Qloo call log are appended", async () => {
    const store = await setup([cardDoc({ id: "c1" }), cardDoc({ id: "c2", day: 1, day_name: "tuesday", qloo_entity_id: "E-2" })], true);
    findAtHome.mockImplementation(async (ctx) => {
      void ctx;
      return result({
        card: newCard(),
        refusals: [
          { day: "monday", hour: 19, entity_id: "R1", name: "Moved", rule: "R-OPEN", detail: "closed", verdict: "REFUSE", movedTo: 15 },
          { day: "monday", hour: 19, entity_id: "R2", name: "Plain", rule: "R-ALC", detail: "beer", verdict: "REFUSE" },
        ],
        review: [newCard({ entity_id: "RV", name: "Held", verdict: "REVIEW" })],
        returned: 3,
      });
    });
    const r = await actOnCard({ store, planId: PLAN_ID, cardId: "c1", action: "swap", qloo: oneCall });
    expect(r.swap).toMatchObject({ found: true, calls: 1 });
    const next = r.plan;
    expect(next.cards.map((c) => [c.day_name, c.name, c.routed_by])).toEqual([["monday", "Replacement", "swap"], ["tuesday", "Thing", "llm"]]);
    expect(next.cards[0]).toMatchObject({ coaching_by: "template", tool: "findAtHome", tool_params: { day: "monday", swap_of: "E-x" } });
    expect(next.empty_slots).toEqual([]);
    expect(next.refusals.map((x) => [x.rule, x.qloo_entity_id, x.moved_to])).toEqual([["CLINICIAN", "E-x", undefined], ["R-OPEN", "R1", 15], ["R-ALC", "R2", undefined]]);
    expect(next.refusals[0]).toMatchObject({ by_clinician: "swapped" });
    expect(next.review.map((x) => [x.name, x.routed_by])).toEqual([["Held", "swap"]]);
    // the prior call doc is kept and merged with this swap's call
    expect(next.qloo_calls).toBe(2);
    expect((await store.getCalls(PLAN_ID))!.calls.map((c) => c.path)).toEqual(["/old", "/v2/insights"]);
  });

  it("no replacement: the card is dropped, the slot is empty with the tool's reason, and a call doc is created when none existed", async () => {
    const store = await setup([cardDoc({ id: "c1" })]);
    findAtHome.mockResolvedValueOnce(result({ empty: "no verified artist" }));
    const a = await actOnCard({ store, planId: PLAN_ID, cardId: "c1", action: "swap", qloo: noQloo });
    expect(a.swap).toMatchObject({ found: false });
    expect(a.plan.cards).toEqual([]);
    expect(a.plan.empty_slots).toEqual([{ day_name: "monday", hour: 19, rung: "home", reason: "no verified artist", routed_by: "swap" }]);
    expect((await store.getCalls(PLAN_ID))!.calls).toEqual([]);
    expect(a.plan.qloo_calls).toBe(0);
  });

  it("no replacement and no reason from the tool: the default reason is stored", async () => {
    const store = await setup([cardDoc({ id: "c1" })]);
    findAtHome.mockResolvedValueOnce(result());
    const a = await actOnCard({ store, planId: PLAN_ID, cardId: "c1", action: "swap", qloo: noQloo });
    expect(a.plan.empty_slots[0]!.reason).toBe("no other verified candidate");
  });

  it("the default Qloo client comes from the environment when the caller injects none", async () => {
    vi.stubEnv("QLOO_API_KEY", "test-key");
    const store = await setup([cardDoc({ id: "c1" })]);
    findAtHome.mockResolvedValueOnce(result());
    await actOnCard({ store, planId: PLAN_ID, cardId: "c1", action: "swap" });
    const ctx = findAtHome.mock.calls[0]![0];
    expect(typeof ctx.qloo.insights).toBe("function");
  });

  it("a swap of a card whose case is gone is a 404-style NotFound; an unknown plan too", async () => {
    const store = new MemoryStore();
    await store.putPlan(planDoc([cardDoc({ id: "c1" })]));
    await expect(actOnCard({ store, planId: PLAN_ID, cardId: "c1", action: "swap", qloo: noQloo })).rejects.toThrow(/case .* not found/);
    await expect(actOnCard({ store, planId: "33333333-3333-4333-8333-333333333333", cardId: "c1", action: "approve" })).rejects.toThrow(/plan .* not found/);
  });
});
