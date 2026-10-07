import { describe, expect, it } from "vitest";
import { makeLlm } from "../lib/llm";
import { recheckConstraints } from "../lib/plan";
import type { QlooCallLog, QlooClient } from "../lib/qloo";
import { latestReceipts, percentile, summarise } from "../lib/receipts";
import { caseFromSeed, runPlanForCase, toggleConstraints } from "../lib/service";
import { cardFromDoc, MemoryStore, PlanDoc } from "../lib/store";
import { replayClient } from "./replay";
import { POST as toggleRoute } from "../app/api/plans/[id]/constraints/route";

const downLlm = () => makeLlm("qwen", { QWEN_API_KEY: "k" }, (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch)!;
const loggingReplay = (onCall: (l: QlooCallLog) => void): QlooClient => {
  const inner = replayClient();
  return {
    async insights(p: Parameters<QlooClient["insights"]>[0]) {
      const r = await inner.insights(p);
      onCall({ path: "/v2/insights", params: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)])), status: 200, ms: 5, n_results: r.results.entities?.length ?? 0, attempts: 1, at: new Date().toISOString() });
      return r;
    },
  } as unknown as QlooClient;
};

async function mayaWeek() {
  const store = new MemoryStore();
  const c = caseFromSeed("maya")!;
  await store.putCase(c);
  const plan = await runPlanForCase({ store, caseId: c.id, qloo: loggingReplay, llms: [downLlm()] });
  return { store, c, plan };
}

describe("constraint toggle (POST /api/plans/:id/constraints)", () => {
  it("in recovery ON: an alcohol-tagged outing is struck in place with R-ALC and only that slot is refilled", async () => {
    const { store, plan } = await mayaWeek();
    // make one placed outing an alcohol venue, as the P19 leak did (craft_beer tag missed by Qloo's exclusion)
    const target = plan.cards.find((x) => x.rung === "solo")!;
    const doctored = PlanDoc.parse({ ...plan, cards: plan.cards.map((x) => (x.id === target.id ? { ...x, tags: [...x.tags, "urn:tag:beverage_offering:qloo:craft_beer"] } : x)) });
    await store.putPlan(doctored);
    const { plan: next, case: nc } = await toggleConstraints({ store, planId: plan.id, patch: { in_recovery: true }, qloo: loggingReplay });
    expect(next.id).not.toBe(plan.id);
    expect(next.parent_plan_id).toBe(plan.id);
    expect(next.origin).toBe("toggle");
    expect(nc.in_recovery).toBe(true);
    expect(nc.id).not.toBe(plan.case_id);
    const struck = next.refusals.filter((r) => r.struck_by_toggle);
    expect(struck.map((r) => [r.name, r.rule])).toContainEqual([target.name, "R-ALC"]);
    const struckDays = new Set(struck.map((r) => r.day_name));
    expect(next.toggle).toMatchObject({ changed: { in_recovery: true }, refilled: struckDays.size, struck: struck.length });
    // the struck entity never comes back on its day; home cards and untouched outings are kept as they were
    expect(next.cards.find((x) => x.day_name === target.day_name)?.qloo_entity_id).not.toBe(target.qloo_entity_id);
    for (const old of plan.cards.filter((x) => !struckDays.has(x.day_name))) expect(next.cards.find((x) => x.day_name === old.day_name)?.qloo_entity_id).toBe(old.qloo_entity_id);
    // I3 after the toggle: every outing on the new week passes R-ALC with in_recovery set
    for (const card of next.cards.filter((x) => x.rung !== "home")) expect(recheckConstraints(cardFromDoc(card), { inRecovery: true, needQuiet: false, needWheelchair: false, maxMeters: nc.max_meters, priceMax: nc.price_max }).filter((r) => r.verdict !== "PASS")).toEqual([]);
    // the old plan and its case are untouched (the history stays consistent)
    expect(await store.getPlan(plan.id)).toEqual(doctored);
    expect((await store.getCase(plan.case_id))!.in_recovery).toBe(false);
    // the new plan's call log carries the parent's calls plus the refill's
    const calls = (await store.getCalls(next.id))!.calls;
    expect(calls.length).toBe(next.qloo_calls);
    expect(calls.length).toBeGreaterThan(plan.qloo_calls);
  });

  it("tightening the distance strikes outings beyond it with R-NEAR; a no-op patch returns the same plan", async () => {
    const { store, plan } = await mayaWeek();
    const far = plan.cards.filter((x) => x.rung !== "home" && (x.distance_m ?? 0) > 800);
    const r = await toggleConstraints({ store, planId: plan.id, patch: { max_meters: 800 }, qloo: loggingReplay });
    expect(r.plan.refusals.filter((x) => x.struck_by_toggle && x.rule === "R-NEAR").length).toBe(far.length);
    for (const c of r.plan.cards.filter((x) => x.rung !== "home")) expect(c.distance_m!).toBeLessThanOrEqual(800);
    const same = await toggleConstraints({ store, planId: plan.id, patch: { in_recovery: false }, qloo: loggingReplay });
    expect(same.plan.id).toBe(plan.id);
  });

  it("coverage refusal → widening the radius (loosening) retries only the empty outing slots, live", async () => {
    const store = new MemoryStore();
    const c = { ...caseFromSeed("maya")!, max_meters: 300 };
    await store.putCase(c);
    // 300 m around Maya: every captured place is further away, so the outings are left empty (a coverage refusal)
    const plan = await runPlanForCase({ store, caseId: c.id, qloo: loggingReplay, llms: [downLlm()] });
    const emptyOutings = plan.empty_slots.filter((e) => e.rung !== "home");
    expect(emptyOutings.length).toBeGreaterThan(0);
    const homes = plan.cards.filter((x) => x.rung === "home").map((x) => x.qloo_entity_id);
    const r = await toggleConstraints({ store, planId: plan.id, patch: { max_meters: 1500 }, qloo: loggingReplay });
    expect(r.plan.toggle).toMatchObject({ changed: { max_meters: 1500 }, struck: 0, refilled: emptyOutings.length });
    expect(r.plan.cards.filter((x) => x.rung !== "home").length).toBeGreaterThan(0);
    for (const x of r.plan.cards.filter((x) => x.rung !== "home")) expect(x.distance_m!).toBeLessThanOrEqual(1500);
    // verified at-home cards are kept as they were
    expect(r.plan.cards.filter((x) => x.rung === "home").map((x) => x.qloo_entity_id)).toEqual(homes);
  });

  it("the route validates the patch (unknown keys → 400), 404s an unknown plan and refuses a non-draft week (409)", async () => {
    const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
    const post = (id: string, body: unknown) => toggleRoute(new Request(`http://x/api/plans/${id}/constraints`, { method: "POST", body: JSON.stringify(body) }), ctx(id));
    expect((await post(crypto.randomUUID(), { in_recovery: true })).status).toBe(404);
    expect((await post(crypto.randomUUID(), { llm_may_loosen: true })).status).toBe(400);
    expect((await post(crypto.randomUUID(), { max_meters: 50000 })).status).toBe(400);
    const { store, plan } = await mayaWeek();
    await store.putPlan({ ...plan, status: "approved" });
    await expect(toggleConstraints({ store, planId: plan.id, patch: { in_recovery: true }, qloo: loggingReplay })).rejects.toThrow(/draft/);
  });
});

describe("receipts (/integrations/qloo)", () => {
  it("aggregates endpoints, distinct product params and latency from the stored call logs only", async () => {
    const { store, plan } = await mayaWeek();
    const r = await latestReceipts(store, { planId: plan.id }, 1);
    expect(r.plans).toHaveLength(1);
    expect(r.totals.calls).toBe(plan.qloo_calls);
    expect(r.totals.endpoints).toEqual(["/v2/insights"]);
    expect(r.totals.params).toContain("filter.hours");
    expect(r.totals.params).not.toContain("take");
    expect(JSON.stringify(r)).not.toMatch(/api[-_]?key/i);
  });

  it("percentile and summary edge cases", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 100], 95)).toBe(100);
    expect(summarise([])).toMatchObject({ calls: 0, non200: 0, p50: null });
  });
});
