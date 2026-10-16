import { describe, expect, it } from "vitest";
import { makeLlm } from "../lib/llm";
import { recheckConstraints } from "../lib/plan";
import type { QlooCallLog, QlooClient } from "../lib/qloo";
import { latestReceipts, percentile, resetReceiptsCache, summarise } from "../lib/receipts";
import { caseFromSeed, latestVersion, planRunState, runPlanForCase, toggleConstraints } from "../lib/service";
import { actOnCard, approveWeek } from "../lib/gate";
import { errorResponse } from "../lib/http";
import { printSheet, realRefusals } from "../lib/view";
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
    // the old plan and its case are untouched apart from the pointer to the week that replaced it
    expect(await store.getPlan(plan.id)).toEqual({ ...doctored, superseded_by: next.id });
    expect((await store.getCase(plan.case_id))!.in_recovery).toBe(false);
    // the new plan's call log carries the parent's calls plus the refill's
    const calls = (await store.getCalls(next.id))!.calls;
    expect(calls.length).toBe(next.qloo_calls);
    expect(calls.length).toBeGreaterThan(plan.qloo_calls);
  });

  it("the cards a toggle refilled get one raced coaching call through the truth-boundary rules (QA round 3)", async () => {
    const { store, plan } = await mayaWeek();
    const target = plan.cards.find((x) => x.rung === "solo")!;
    await store.putPlan(PlanDoc.parse({ ...plan, cards: plan.cards.map((x) => (x.id === target.id ? { ...x, tags: [...x.tags, "urn:tag:beverage_offering:qloo:craft_beer"] } : x)) }));
    const prompts: string[] = [];
    const llm = makeLlm("groq", { GROQ_API_KEY: "k" }, (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: { content: unknown }[] };
      const text = body.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      prompts.push(text);
      const ids = [...new Set([...text.matchAll(/"entity_id":"([^"]+)"/g)].map((m) => m[1]!))];
      const coaching = ids.map((entity_id, i) => ({ entity_id, line: i === 0 ? "Fifteen minutes there is plenty." : "Stay for an hour or two." }));
      return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "submitPlan", arguments: JSON.stringify({ coaching }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch)!;
    const { plan: next } = await toggleConstraints({ store, planId: plan.id, patch: { in_recovery: true }, qloo: loggingReplay, llms: [llm], coachWindowMs: 3000 });
    const refills = next.cards.filter((c) => c.routed_by === "toggle");
    expect(refills.length).toBeGreaterThan(0);
    expect(prompts).toHaveLength(1);
    // only refilled cards were offered to the model
    for (const c of next.cards.filter((x) => x.routed_by !== "toggle")) expect(prompts[0]).not.toContain(c.qloo_entity_id);
    expect(refills[0]!.coaching_by).toBe("llm");
    expect(refills[0]!.coaching).toBe("Fifteen minutes there is plenty.");
    // a line breaking a rule (COACH-DOSE: an hour) keeps the template
    for (const c of refills.slice(1)) expect(c.coaching_by).toBe("template");
    expect(next.coach_llm).toMatch(/^groq:/);
  });

  it("a2a r10: a toggle coaching call whose every line the boundary drops does not win; the drops are still logged", async () => {
    const { store, plan } = await mayaWeek();
    const target = plan.cards.find((x) => x.rung === "solo")!;
    await store.putPlan(PlanDoc.parse({ ...plan, cards: plan.cards.map((x) => (x.id === target.id ? { ...x, tags: [...x.tags, "urn:tag:beverage_offering:qloo:craft_beer"] } : x)) }));
    const llm = makeLlm("groq", { GROQ_API_KEY: "k" }, (async (_u: string, init: RequestInit) => {
      const text = JSON.stringify(JSON.parse(String(init.body)).messages);
      const ids = [...new Set([...text.matchAll(/entity_id\\":\\"([^"\\]+)/g)].map((m) => m[1]!))];
      const coaching = ids.map((entity_id) => ({ entity_id, line: "Stay for an hour or two." }));
      return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "submitPlan", arguments: JSON.stringify({ coaching }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch)!;
    const { plan: next } = await toggleConstraints({ store, planId: plan.id, patch: { in_recovery: true }, qloo: loggingReplay, llms: [llm], coachWindowMs: 3000 });
    const refills = next.cards.filter((c) => c.routed_by === "toggle");
    expect(refills.length).toBeGreaterThan(0);
    for (const c of refills) {
      expect(c.coaching_by).toBe("template");
      expect(next.dropped).toContainEqual(expect.objectContaining({ rule: "COACH-DOSE", entity_id: c.qloo_entity_id }));
    }
    expect(next.coach_llm).toBeNull();
    expect(next.llm_errors.map((e) => e.error)).toContainEqual(expect.stringContaining("toggle coaching: Error: the model's submitPlan had no usable line"));
  });

  it("in recovery ON re-screens every card's coaching, home cards too (COACH-ALC): a drinking line becomes the template dose", async () => {
    const { store, plan } = await mayaWeek();
    const home = plan.cards.find((x) => x.rung === "home")!;
    const line = "Put on Lucy Dacus at 19:00 and just let one song play while you sit with a drink. No need to do more.";
    await store.putPlan(PlanDoc.parse({ ...plan, cards: plan.cards.map((x) => (x.id === home.id ? { ...x, coaching: line, coaching_by: "llm" } : x)) }));
    const { plan: next } = await toggleConstraints({ store, planId: plan.id, patch: { in_recovery: true }, qloo: loggingReplay });
    const after = next.cards.find((x) => x.qloo_entity_id === home.qloo_entity_id)!;
    expect(after.coaching).not.toBe(line);
    expect(after.coaching_by).toBe("template");
    expect(next.dropped).toContainEqual(expect.objectContaining({ rule: "COACH-ALC", entity_id: home.qloo_entity_id }));
    for (const c of next.cards) expect(c.coaching).not.toMatch(/\b(drinks?|beer|wine|cocktail|bar)\b/i);
  });

  it("tightening the distance strikes outings beyond it with R-NEAR; a no-op patch returns the same plan", async () => {
    const { store, plan } = await mayaWeek();
    const far = plan.cards.filter((x) => x.rung !== "home" && (x.distance_m ?? 0) > 800);
    const r = await toggleConstraints({ store, planId: plan.id, patch: { max_meters: 800 }, qloo: loggingReplay });
    expect(r.plan.refusals.filter((x) => x.struck_by_toggle && x.rule === "R-NEAR").length).toBe(far.length);
    for (const c of r.plan.cards.filter((x) => x.rung !== "home")) expect(c.distance_m!).toBeLessThanOrEqual(800);
    const same = await toggleConstraints({ store, planId: r.plan.id, patch: { in_recovery: false }, qloo: loggingReplay });
    expect(same.plan.id).toBe(r.plan.id);
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

describe("a toggle replaces the week it was applied to (QA round 3)", () => {
  it("the pre-toggle draft can no longer be approved, acted on, toggled or printed; links resolve to the newest version", async () => {
    const { store, plan } = await mayaWeek();
    const { plan: p2, case: c2 } = await toggleConstraints({ store, planId: plan.id, patch: { in_recovery: true }, qloo: loggingReplay });
    const { plan: p3 } = await toggleConstraints({ store, planId: p2.id, patch: { max_meters: 800 }, qloo: loggingReplay });
    const old = (await store.getPlan(plan.id))!;
    expect(old.superseded_by).toBe(p2.id);
    // approve the parent → 409 with the newer week's id, and nothing is stamped
    const err = await approveWeek({ store, planId: plan.id }).catch((e) => e);
    const res = errorResponse(err);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ superseded_by: p2.id });
    expect((await store.getPlan(plan.id))!.status).toBe("draft");
    await expect(actOnCard({ store, planId: plan.id, cardId: plan.cards[0]!.id, action: "approve" })).rejects.toThrow(/replaced by a constraint change/);
    await expect(toggleConstraints({ store, planId: plan.id, patch: { need_quiet: true }, qloo: loggingReplay })).rejects.toThrow(/replaced by a constraint change/);
    // even an approved-before-the-fix superseded week prints nothing
    expect(printSheet({ ...old, status: "approved", cards: old.cards.map((c) => ({ ...c, clinician_action: "approved" as const })) }).printable).toBe(false);
    // /plans/<old> and /cases/<old case> resolve to the newest version; the toggled case opens its own week
    expect((await latestVersion(store, old)).id).toBe(p3.id);
    const run = await planRunState(store, c2.id);
    expect(run && "plan" in run && run.plan.id).toBe(p2.id);
    // the newest version is approvable
    expect((await approveWeek({ store, planId: p3.id })).status).toBe("approved");
    // receipts list only the newest version (it carries the replaced weeks' calls too)
    const r = await latestReceipts(store, { limit: 5 }, 10_000_000);
    expect(r.plans.map((x) => x.plan.id)).toEqual([p3.id]);
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

  it("QA round 4: receipts count each struck venue once per day and rule, like the sheet (the social ladder re-refuses)", async () => {
    resetReceiptsCache();
    const { store, plan } = await mayaWeek();
    // as in spike/plan-http-live.json: the social ladder refused CookUnity twice on Sunday (R-KIND); add a second rule too
    const strike = (rule: string) => ({ id: crypto.randomUUID(), plan_id: plan.id, qloo_entity_id: "cook-unity", name: "CookUnity", rule, detail: "not an activity: personal_care", verdict: "REFUSE" as const, day_name: "sunday" as const, hour: 14 });
    await store.putPlan(PlanDoc.parse({ ...plan, refusals: [...plan.refusals, strike("R-KIND"), strike("R-KIND"), strike("R-OPEN")] }));
    const r = await latestReceipts(store, { planId: plan.id });
    const base = realRefusals(plan.refusals, plan.cards);
    expect(r.plans[0]!.plan.refusals).toBe(new Set(base.map((x) => `${x.day_name}|${x.qloo_entity_id}`)).size + 1); // one struck row on the sheet
    expect(r.plans[0]!.plan.refusals_by_rule["R-KIND"]).toBe(base.filter((x) => x.rule === "R-KIND").length + 1);
  });

  it("percentile and summary edge cases", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 100], 95)).toBe(100);
    expect(summarise([])).toMatchObject({ calls: 0, non200: 0, p50: null });
  });

  it("QA round 4 (a2a r02): a ?plan= receipts view no longer evicts the shared 'latest' entry (whose miss costs a Blob list(), an advanced op)", async () => {
    resetReceiptsCache();
    const store = new MemoryStore();
    let lists = 0;
    const counting = new Proxy(store, {
      get(t, k, r) {
        const v = Reflect.get(t, k, r);
        if (k === "listPlanIds") return async (...a: unknown[]) => (lists++, (v as (...x: unknown[]) => unknown).apply(t, a));
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    await latestReceipts(counting, { limit: 5 }, 10_000_000);
    await latestReceipts(counting, { limit: 5, planId: crypto.randomUUID() }, 10_000_001);
    await latestReceipts(counting, { limit: 5 }, 10_000_002);
    expect(lists).toBe(1);
    resetReceiptsCache();
  });
});
