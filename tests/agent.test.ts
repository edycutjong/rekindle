import { describe, expect, it } from "vitest";
import { assembleCoaching, coachingAlcohol, doseConflict, namedMinutes, runAgent, templateCoaching, usableLines, type AgentEvent, type AgentSlot } from "../lib/agent";
import { llmChainFromEnv, makeLlm, type LlmHandle } from "../lib/llm";
import type { InsightsResponse, QlooClient, QlooParams } from "../lib/qloo";
import { ALCOHOL_EXCLUDE_14 } from "../lib/tags";
import type { Card } from "../lib/plan";
import { MAYA, replayClient } from "./replay";
import { planDocFromAgent } from "../lib/store";
import { EMPTY_HISTORY } from "../lib/plan";
import { llmFailure, routingLabel, traceLine } from "../lib/view";

/* A scripted OpenAI-compatible endpoint: the agent runs the real AI SDK loop against it (test-only; the app calls the
 * real provider). Each handler sees the request body (incl. earlier tool results) and returns the next assistant turn. */
type Body = { model: string; messages: { role: string; content: unknown }[]; enable_thinking?: boolean; tools?: unknown[] };
type ToolCall = { name: string; args: unknown };

const completion = (calls: ToolCall[], content: string | null = null) =>
  new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: "scripted",
      choices: [{ index: 0, message: { role: "assistant", content, tool_calls: calls.length ? calls.map((c, i) => ({ id: `call_${i}_${c.name}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) : undefined }, finish_reason: calls.length ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

function scriptedLlm(turns: ((b: Body) => Response)[], bodies: Body[] = [], provider: "qwen" | "groq" = "qwen"): LlmHandle {
  let i = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body;
    bodies.push(body);
    const turn = turns[Math.min(i++, turns.length - 1)];
    return turn(body);
  }) as unknown as typeof fetch;
  return makeLlm(provider, { QWEN_API_KEY: "k", GROQ_API_KEY: "k" }, fetchImpl)!;
}

const failingLlm = (provider: "qwen" | "groq", status = 503): LlmHandle =>
  makeLlm(provider, { QWEN_API_KEY: "k", GROQ_API_KEY: "k" }, (async () => new Response(JSON.stringify({ error: { message: "model overloaded" } }), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch)!;

/** entity IDs of the placed cards the coaching call was given (its user prompt lists them; earlier: tool results) */
function placedIds(b: Body): string[] {
  const text = b.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
  return [...new Set([...text.matchAll(/"entity_id":"([^"]+)"/g)].map((m) => m[1]))];
}

const ROUTE_ALL: ToolCall[] = [
  { name: "findAtHome", args: { day: "monday", type: "artist" } },
  { name: "findAtHome", args: { day: "tuesday", type: "podcast" } },
  { name: "findAtHome", args: { day: "wednesday", type: "book" } },
  { name: "findOutings", args: { day: "thursday", hour: 18, narrowMeters: 5000 } },
  { name: "findAtHome", args: { day: "friday", type: "tv_show" } },
  { name: "findOutings", args: { day: "saturday", hour: 11 } },
  { name: "placeSocial", args: { day: "sunday" } },
];

describe("agent loop (AI SDK tool loop over the deterministic tools)", () => {
  it("routes all 7 slots through the LLM's typed tool calls; every card is a Qloo entity returned in this run (I1)", async () => {
    const qlooRequests: QlooParams[] = [];
    const bodies: Body[] = [];
    const events: AgentEvent[] = [];
    const llm = scriptedLlm([() => completion(ROUTE_ALL), (b) => completion([{ name: "submitPlan", args: { coaching: placedIds(b).map((entity_id) => ({ entity_id, line: "Ten minutes is plenty; stop whenever you like." })) } }])], bodies);
    const plan = await runAgent({ qloo: replayClient(qlooRequests), case: MAYA, llms: [llm], onEvent: (e) => events.push(e) });

    expect(plan.slots).toHaveLength(7);
    expect(plan.slots.every((s) => s.routedBy === "llm")).toBe(true);
    expect(plan.llm).toEqual({ provider: "qwen", model: "qwen3.8-flash" });
    const cards = plan.slots.flatMap((s) => (s.card ? [s.card] : []));
    expect(cards.length).toBeGreaterThanOrEqual(5);
    const returnedIds = new Set<string>();
    for (const e of events) if (e.type === "tool" && e.card) returnedIds.add(e.card.entity_id);
    for (const c of cards) {
      expect(c.entity_id).toMatch(/\S/);
      expect(returnedIds.has(c.entity_id)).toBe(true);
      expect(c.verdict).toBe("PASS");
    }
    expect(plan.slots.filter((s) => s.card).every((s) => s.coachingBy === "llm")).toBe(true);
    // thinking stays off on every Qwen call
    expect(bodies.every((b) => b.enable_thinking === false)).toBe(true);
    // the LLM's narrowMeters 5000 cannot loosen Maya's 1500 m (I6)
    for (const p of qlooRequests.filter((p) => p["filter.type"] === "urn:entity:place" && p["filter.location.radius"] !== undefined)) expect(Number(p["filter.location.radius"])).toBeLessThanOrEqual(1500);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["start", "llm", "tool", "plan"]));
  });

  it("no constraint is in any tool schema, and the case flags are not sent to the LLM", async () => {
    const bodies: Body[] = [];
    await runAgent({ qloo: replayClient(), case: { ...MAYA, inRecovery: true, needQuiet: true }, llms: [scriptedLlm([() => completion(ROUTE_ALL), () => completion([{ name: "submitPlan", args: { coaching: [] } }])], bodies)] });
    // what the model learns about this case (user turn) and what it can pass (tool schemas)
    const wire = JSON.stringify([bodies[0].messages.filter((m) => m.role === "user"), bodies[0].tools]).toLowerCase();
    for (const banned of ["recovery", "alcohol", "quiet", "wheelchair", "price", "budget", "sober"]) expect(wire).not.toContain(banned);
    expect(JSON.stringify(bodies[0].tools)).toContain("narrowMeters");
  });

  it("I7 holds whatever the LLM asks: in recovery, every place request carries the 14 exclusion tags", async () => {
    const seen: QlooParams[] = [];
    await runAgent({ qloo: replayClient(seen), case: { ...MAYA, inRecovery: true }, llms: [scriptedLlm([() => completion(ROUTE_ALL), () => completion([{ name: "submitPlan", args: { coaching: [] } }])])] });
    const places = seen.filter((p) => p["filter.type"] === "urn:entity:place");
    expect(places.length).toBeGreaterThan(0);
    for (const p of places) expect(p["filter.exclude.tags"]).toEqual(expect.arrayContaining([...ALCOHOL_EXCLUDE_14]));
  });

  it("truth boundary: a coaching line keyed to an ID no tool returned is dropped and logged as R-ID; the card keeps a template line", async () => {
    const events: AgentEvent[] = [];
    const llm = scriptedLlm([
      () => completion(ROUTE_ALL),
      (b) => {
        const ids = placedIds(b);
        return completion([
          {
            name: "submitPlan",
            args: {
              coaching: [
                { entity_id: "INVENTED-VENUE-0001", line: "Go to The Invented Bar on Bedford Ave." },
                { entity_id: ids[0], line: "word ".repeat(30).trim() },
                { entity_id: ids[1], line: "It is a 12 min walk, about 900 m away." },
              ],
            },
          },
        ]);
      },
    ]);
    const plan = await runAgent({ qloo: replayClient(), case: MAYA, llms: [llm], onEvent: (e) => events.push(e) });
    expect(plan.dropped.map((d) => d.rule)).toEqual(["R-ID", "COACH-LENGTH", "COACH-FACT"]);
    expect(plan.slots.some((s) => s.card?.entity_id === "INVENTED-VENUE-0001")).toBe(false);
    expect(JSON.stringify(plan.slots)).not.toContain("Invented Bar");
    expect(plan.slots.filter((s) => s.card).every((s) => s.coachingBy === "template" && s.coaching)).toBe(true);
    expect(events.some((e) => e.type === "truth_boundary")).toBe(true);
  });

  it("a tool call for the wrong rung is rejected and that slot is routed by the deterministic fallback", async () => {
    const events: AgentEvent[] = [];
    const calls = ROUTE_ALL.filter((c) => (c.args as { day: string }).day !== "thursday");
    calls.push({ name: "findOutings", args: { day: "monday" } }); // monday is a home slot
    const plan = await runAgent({ qloo: replayClient(), case: MAYA, llms: [scriptedLlm([() => completion(calls), () => completion([{ name: "submitPlan", args: { coaching: [] } }])])], onEvent: (e) => events.push(e) });
    expect(events.some((e) => e.type === "tool_rejected" && e.day === "monday")).toBe(true);
    const thu = plan.slots.find((s) => s.slot.day === "thursday")!;
    expect(thu.routedBy).toBe("fallback");
    expect(plan.slots.filter((s) => s.routedBy === "llm")).toHaveLength(6);
  });

  it("a model that stops early gets another round for the open slots, then the coaching hand-off (sequential Qwen, 2026-10-07)", async () => {
    const bodies: Body[] = [];
    const llm = scriptedLlm(
      [
        () => completion([ROUTE_ALL[0]]),
        () => completion([], "Monday is done."),
        () => completion(ROUTE_ALL.slice(1)),
        // the coaching turn sees this round's tool results plus the cards placed in the earlier round (in the prompt)
        (b) => completion([{ name: "submitPlan", args: { coaching: [...new Set([...JSON.stringify(b.messages).matchAll(/entity_id\\?":\\?"([^"\\]+)/g)].map((m) => m[1]))].map((entity_id) => ({ entity_id, line: "One small step is enough." })) } }]),
      ],
      bodies,
    );
    const plan = await runAgent({ qloo: replayClient(), case: MAYA, llms: [llm] });
    expect(plan.slots.every((s) => s.routedBy === "llm")).toBe(true);
    expect(plan.slots.filter((s) => s.card).every((s) => s.coachingBy === "llm")).toBe(true);
    expect(plan.llmErrors).toEqual([]);
    // the second round only offers what is still open
    const secondRoundUser = JSON.stringify(bodies[2].messages.filter((m) => m.role === "user"));
    expect(secondRoundUser).not.toContain("- monday 19:00 home");
    expect(secondRoundUser).toContain("Already placed");
    expect(bodies.filter((b) => b.tools).every((b) => (b as unknown as { parallel_tool_calls?: boolean }).parallel_tool_calls === true)).toBe(true);
  });

  it("LLM fallback switch: the primary fails, the secondary provider routes the week", async () => {
    const events: AgentEvent[] = [];
    const plan = await runAgent({ qloo: replayClient(), case: MAYA, llms: [failingLlm("qwen"), scriptedLlm([() => completion(ROUTE_ALL), (b) => completion([{ name: "submitPlan", args: { coaching: placedIds(b).map((entity_id) => ({ entity_id, line: "One small step is plenty." })) } }])], [], "groq")], onEvent: (e) => events.push(e) });
    expect(events.find((e) => e.type === "llm_fallback")).toMatchObject({ from: "qwen:qwen3.8-flash", to: "groq:openai/gpt-oss-120b" });
    expect(plan.llm?.provider).toBe("groq");
    expect(plan.llmErrors).toHaveLength(1);
    expect(plan.slots.every((s) => s.routedBy === "llm")).toBe(true);
  });

  it("QA 2026-10-09 (demo video): each LLM slot names the provider that routed it, and a failed coaching call reads as coaching, not as a deterministic route", async () => {
    // the live re-plan 7317047a: Qwen routed Monday then timed out, Groq routed the other slots, then Groq's coaching call
    // hit its tokens-per-minute limit; the trace printed "→ deterministic route" and the stats credited Qwen with the week
    let q = 0;
    const qwen = makeLlm("qwen", { QWEN_API_KEY: "k" }, (async (_u: string, init: RequestInit) =>
      q++ === 0 ? completion([ROUTE_ALL[0]]) : new Promise<Response>((_, rej) => init.signal?.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch)!;
    let g = 0;
    const limited = () =>
      new Response(JSON.stringify({ error: { message: "Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Used 6686, Requested 1462." } }), { status: 429, headers: { "content-type": "application/json" } });
    const groq = makeLlm("groq", { GROQ_API_KEY: "k" }, (async () => (g++ === 0 ? completion(ROUTE_ALL.slice(1)) : limited())) as unknown as typeof fetch)!;
    const events: AgentEvent[] = [];
    const plan = await runAgent({ qloo: replayClient(), case: MAYA, llms: [qwen, groq], llmBudgetMs: 6000, coachBudgetMs: 2000, onEvent: (e) => events.push(e) });
    expect(plan.slots.find((s) => s.slot.day === "monday")).toMatchObject({ routedBy: "llm", llm: "qwen:qwen3.8-flash" });
    expect(plan.slots.filter((s) => s.slot.day !== "monday").every((s) => s.routedBy === "llm" && s.llm === "groq:openai/gpt-oss-120b")).toBe(true);
    const fb = events.filter((e) => e.type === "llm_fallback");
    expect(fb).toEqual([
      expect.objectContaining({ stage: "route", from: "qwen:qwen3.8-flash", to: "groq:openai/gpt-oss-120b", open: 6 }),
      expect.objectContaining({ stage: "coach", from: "groq:openai/gpt-oss-120b", to: null }),
    ]);
    expect(fb.map((e) => traceLine(e as unknown as { type: string } & Record<string, unknown>))).toEqual([
      "LLM fallback qwen:qwen3.8-flash (timed out) → groq:openai/gpt-oss-120b",
      "coaching groq:openai/gpt-oss-120b rate-limited → template lines",
    ]);
    expect(plan.coachedBy).toBeNull();
    expect(plan.slots.filter((s) => s.card).every((s) => s.coachingBy === "template")).toBe(true);
    // the stored week credits each provider with its own slots
    const doc = planDocFromAgent(plan, { caseId: "c", history: EMPTY_HISTORY, calls: 0 });
    expect(doc.cards.map((c) => c.routed_llm)).toEqual(plan.slots.filter((s) => s.card).map((s) => s.llm));
    expect(routingLabel(doc)).toBe("groq:openai/gpt-oss-120b ×6 · qwen:qwen3.8-flash ×1");
  }, 15_000);

  it("coaching is a race: a primary that hangs loses to the other provider, which coaches every card (QA round 3: Qwen timed out on 5/5 runs)", async () => {
    let n = 0;
    // Qwen routes the week, then hangs on the coaching call until it is aborted
    const slowQwen = makeLlm("qwen", { QWEN_API_KEY: "k" }, (async (_u: string, init: RequestInit) =>
      n++ === 0 ? completion(ROUTE_ALL) : new Promise<Response>((_, rej) => init.signal?.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch)!;
    const groq = scriptedLlm([(b) => completion([{ name: "submitPlan", args: { coaching: placedIds(b).map((entity_id) => ({ entity_id, line: "One small step is plenty; stop whenever you like." })) } }])], [], "groq");
    const t = Date.now();
    const plan = await runAgent({ qloo: replayClient(), case: MAYA, llms: [slowQwen, groq], coachBudgetMs: 3000 });
    expect(plan.llm?.provider).toBe("qwen");
    expect(plan.coachedBy?.provider).toBe("groq");
    // the loser was aborted when Groq won, not after the window: no error, no wait
    expect(plan.llmErrors).toEqual([]);
    expect(Date.now() - t).toBeLessThan(2500);
    expect(plan.slots.filter((s) => s.card).every((s) => s.coachingBy === "llm")).toBe(true);
  });

  it("coaching race: two providers that both answer never double-apply lines; two that hang leave the template and both errors", async () => {
    const lines = (b: Parameters<typeof placedIds>[0]) => completion([{ name: "submitPlan", args: { coaching: placedIds(b).map((entity_id) => ({ entity_id, line: "One small step is plenty." })) } }]);
    const both = await runAgent({ qloo: replayClient(), case: MAYA, llms: [scriptedLlm([() => completion(ROUTE_ALL), lines]), scriptedLlm([lines], [], "groq")] });
    expect(both.dropped.filter((d) => d.rule === "COACH-DUPLICATE")).toEqual([]);
    expect(both.slots.filter((s) => s.card).every((s) => s.coachingBy === "llm")).toBe(true);
    const hang = (provider: "qwen" | "groq", routeFirst: boolean) => {
      let k = 0;
      return makeLlm(provider, { QWEN_API_KEY: "k", GROQ_API_KEY: "k" }, (async (_u: string, init: RequestInit) =>
        routeFirst && k++ === 0 ? completion(ROUTE_ALL) : new Promise<Response>((_, rej) => init.signal?.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch)!;
    };
    const none = await runAgent({ qloo: replayClient(), case: MAYA, llms: [hang("qwen", true), hang("groq", false)], llmBudgetMs: 2100, coachBudgetMs: 1600 });
    expect(none.coachedBy).toBeNull();
    expect(none.llmErrors.map((e) => e.provider).sort()).toEqual(["groq", "qwen"]);
    expect(none.slots.filter((s) => s.card).every((s) => s.coachingBy === "template")).toBe(true);
  }, 15_000);

  it("every provider down: the week is routed deterministically by the same tools, never by model text", async () => {
    const plan = await runAgent({ qloo: replayClient(), case: MAYA, llms: [failingLlm("qwen"), failingLlm("groq", 500)] });
    expect(plan.llm).toBeNull();
    expect(plan.slots).toHaveLength(7);
    expect(plan.slots.every((s) => s.routedBy === "fallback")).toBe(true);
    expect(plan.slots.filter((s) => s.card).every((s) => s.coachingBy === "template")).toBe(true);
  });

  it("QA round 4: a tool that throws outside its Qloo try leaves its day empty with the reason; the week keeps all 7 days", async () => {
    // the bench pool hook runs inside findOutings after the Qloo try: a throw there reaches the AI SDK, which turns it into
    // a tool-error part (it used to leave the day `pending` and drop it from the week; the deterministic route threw)
    const boom = { onPool: () => { throw new Error("pool hook failed"); } };
    const route = () => scriptedLlm([() => completion(ROUTE_ALL), () => completion([{ name: "submitPlan", args: { coaching: [] } }])]);
    for (const llms of [[route()], []]) {
      const plan = await runAgent({ qloo: replayClient(), case: MAYA, llms, toolOptions: boom });
      expect(plan.slots.map((s) => s.slot.day)).toEqual(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
      expect(plan.slots.filter((s) => s.slot.rung !== "home").every((s) => s.card === null && /tool failed/.test(s.empty ?? ""))).toBe(true);
    }
  });

  it("QA round 4: a Qloo 200 without `results` is an empty answer, not a crash (the plan path guards like lib/resolve.ts)", async () => {
    const base = replayClient();
    const bare = { insights: async (p: QlooParams) => (p["filter.type"] === "urn:entity:place" || p["filter.type"] === "urn:heatmap" ? ({} as InsightsResponse) : base.insights(p)) } as unknown as QlooClient;
    const plan = await runAgent({ qloo: bare, case: MAYA, llms: [scriptedLlm([() => completion(ROUTE_ALL), () => completion([{ name: "submitPlan", args: { coaching: [] } }])])] });
    expect(plan.slots).toHaveLength(7);
    expect(plan.slots.filter((s) => s.slot.rung !== "home").every((s) => s.card === null && !!s.empty)).toBe(true);
  });

  it("QA round 4: LLM fallback on a TIMEOUT: a primary that hangs leaves the secondary time to route the week (README: 'on a provider error or timeout')", async () => {
    const hung = makeLlm("qwen", { QWEN_API_KEY: "k" }, (async (_u: string, init: RequestInit) =>
      new Promise<Response>((_, rej) => init.signal?.addEventListener("abort", () => rej(init.signal!.reason)))) as unknown as typeof fetch)!;
    const groq = scriptedLlm([() => completion(ROUTE_ALL), (b) => completion([{ name: "submitPlan", args: { coaching: placedIds(b).map((entity_id) => ({ entity_id, line: "One small step is plenty." })) } }])], [], "groq");
    const plan = await runAgent({ qloo: replayClient(), case: MAYA, llms: [hung, groq], llmBudgetMs: 6000, coachBudgetMs: 1600 });
    expect(plan.llm?.provider).toBe("groq");
    expect(plan.slots.every((s) => s.routedBy === "llm")).toBe(true);
    expect(plan.llmErrors.map((e) => e.provider)).toEqual(["qwen"]);
  }, 15_000);

  it("QA round 4 (a2a r01): the deterministic fallback routes its slots concurrently, not one Qloo call after another", async () => {
    const base = replayClient();
    let inFlight = 0;
    let peak = 0;
    const slow = {
      async insights(p: QlooParams) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        try {
          return await base.insights(p);
        } finally {
          inFlight--;
        }
      },
    } as unknown as typeof base;
    const plan = await runAgent({ qloo: slow, case: MAYA, llms: [failingLlm("qwen"), failingLlm("groq", 500)] });
    expect(plan.slots).toHaveLength(7);
    expect(plan.slots.every((s) => s.routedBy === "fallback")).toBe(true);
    expect(peak).toBeGreaterThan(1);
    const ids = plan.slots.filter((s) => s.card).map((s) => s.card!.entity_id);
    expect(new Set(ids).size).toBe(ids.length); // no venue placed twice when slots race
  });

  it("Qloo outage: slots are left empty with the reason; the agent never fills them itself", async () => {
    const plan = await runAgent({ qloo: replayClient([], true), case: MAYA, llms: [scriptedLlm([() => completion(ROUTE_ALL), () => completion([{ name: "submitPlan", args: { coaching: [] } }])])] });
    const outings = plan.slots.filter((s) => s.slot.rung !== "home");
    expect(outings.every((s) => s.card === null && /Qloo unavailable/.test(s.empty ?? ""))).toBe(true);
  });
});

describe("coaching assembler + LLM config", () => {
  const card = (entity_id: string, name: string, rung: Card["rung"] = "solo"): Card =>
    ({ slot: { day: "thursday", hour: 15, rung }, hour: 15, rung, entity_id, name, entityType: rung === "home" ? "urn:entity:artist" : "urn:entity:place", affinity: 0.9, tags: [], why: [], verdict: "PASS", checks: [] }) as Card;
  const slot = (c: Card): AgentSlot => ({ slot: c.slot, card: c, routedBy: "llm", tool: "findOutings", params: {} });

  it("drops a line that names another entity seen in this run (COACH-NAME), keeps the card's own name", () => {
    const a = slot(card("A", "Dun-Well Doughnuts"));
    const b = slot(card("B", "Bakeri"));
    const dropped = assembleCoaching([a, b], [{ entity_id: "A", line: "Skip Dun-Well Doughnuts and try The Meat Hook instead." }, { entity_id: "B", line: "Pick one pastry at Bakeri." }], ["The Meat Hook", "Dun-Well Doughnuts", "Bakeri"]);
    expect(dropped).toEqual([expect.objectContaining({ rule: "COACH-NAME", entity_id: "A" })]);
    expect(b.coaching).toBe("Pick one pastry at Bakeri.");
    expect(a.coachingBy).toBe("template");
  });

  it("allows dose minutes but drops distances, prices and walking times (COACH-FACT)", () => {
    const ok = slot(card("A", "X"));
    const bad = [slot(card("B", "Y")), slot(card("C", "Z")), slot(card("D", "W"))];
    const dropped = assembleCoaching([ok, ...bad], [{ entity_id: "A", line: "Twenty minutes is enough." }, { entity_id: "B", line: "Only 563 m from you." }, { entity_id: "C", line: "Spend under $10." }, { entity_id: "D", line: "A five-minute walk away." }], []);
    expect(ok.coachingBy).toBe("llm");
    expect(dropped.map((d) => d.rule)).toEqual(["COACH-FACT", "COACH-FACT", "COACH-FACT"]);
  });

  it("drops a line whose named duration contradicts the card's dose (COACH-DOSE; QA round 3: '10 MIN' card, '20 minutes' line)", () => {
    const lucy = slot(card("L", "Lucy Dacus", "home"));
    lucy.slot = { ...lucy.slot, homeType: "artist" };
    const home10 = slot(card("H", "Fleabag", "home"));
    const out = slot(card("O", "Ceremonia"));
    const long = slot(card("G", "Bakeri"));
    const dropped = assembleCoaching(
      [lucy, home10, out, long],
      [
        { entity_id: "L", line: "Listen to one Lucy Dacus song you love for 20 minutes." },
        { entity_id: "H", line: "Watch ten minutes of Fleabag, nothing more." },
        { entity_id: "O", line: "Fifteen minutes at Ceremonia is plenty." },
        { entity_id: "G", line: "Spend an hour at Bakeri." },
      ],
      [],
    );
    expect(dropped.map((d) => [d.rule, d.entity_id])).toEqual([["COACH-DOSE", "L"], ["COACH-DOSE", "G"]]);
    expect(lucy.coaching).toBe("Put on one Lucy Dacus song you choose and give it ten minutes.");
    expect([home10.coachingBy, out.coachingBy]).toEqual(["llm", "llm"]);
    expect(namedMinutes("half an hour, then 2 hours, a 20-minute visit, 10 min")).toEqual([30, 120, 20, 10]);
    expect(doseConflict("Listen to one song you choose.", "home")).toBeNull();
  });

  it("drops drinking language on every case (COACH-ALC): the live QA line falls back to the template dose", () => {
    // QA round 1, live 375 px run, Maya with "In recovery" on, Monday card
    const lucy = slot(card("L", "Lucy Dacus", "home"));
    lucy.slot = { ...lucy.slot, homeType: "artist" };
    const tea = slot(card("T", "Ten Tea Bar"));
    const dropped = assembleCoaching([lucy, tea], [{ entity_id: "L", line: "Put on Lucy Dacus at 19:00 and just let one song play while you sit with a drink. No need to do more." }, { entity_id: "T", line: "Sit at Ten Tea Bar with one pot of tea." }], []);
    expect(dropped).toEqual([expect.objectContaining({ rule: "COACH-ALC", entity_id: "L" })]);
    expect(lucy.coaching).toBe("Put on one Lucy Dacus song you choose and give it ten minutes.");
    expect(lucy.coachingBy).toBe("template");
    // the card's own name is not screened ("Tea Bar"); the rest of the line is
    expect(tea.coachingBy).toBe("llm");
    for (const l of ["Grab a beer after.", "Raise a glass of something.", "Happy hour starts at five.", "Meet a friend at the bar.", "Enjoy a cocktail.", "A glass of wine is fine."]) expect(coachingAlcohol(l)).not.toBeNull();
    for (const l of ["Listen to one song you choose.", "Twenty minutes is enough.", "Order one pastry and sit by the window.", "Browse the barbecue sauces.", "Do it for its own sake."]) expect(coachingAlcohol(l)).toBeNull();
  });

  it("template coaching sets the dose by domain and never claims Qloo picked a song or episode", () => {
    expect(templateCoaching(card("A", "Lucy Dacus", "home"), "artist")).toBe("Put on one Lucy Dacus song you choose and give it ten minutes.");
    expect(templateCoaching(card("B", "Dun-Well Doughnuts"))).toContain("15:00");
  });

  it("LLM_PROVIDER picks the primary; the other provider is the fallback only when its key is set", () => {
    expect(llmChainFromEnv({ QWEN_API_KEY: "a", GROQ_API_KEY: "b" }).map((l) => l.provider)).toEqual(["qwen", "groq"]);
    expect(llmChainFromEnv({ LLM_PROVIDER: "groq", QWEN_API_KEY: "a", GROQ_API_KEY: "b" }).map((l) => l.provider)).toEqual(["groq", "qwen"]);
    expect(llmChainFromEnv({ QWEN_API_KEY: "a" }).map((l) => `${l.provider}:${l.modelId}`)).toEqual(["qwen:qwen3.8-flash"]);
    expect(llmChainFromEnv({})).toEqual([]);
  });
});

describe("routing token budget (measured 2026-10-10: Groq-only routing spent ~10,000 tokens and its coaching call hit 8,000 tokens/min)", () => {
  it("a provider past its routing budget hands the open slots on, stays in the coaching race and coaches every card", async () => {
    const coach = (b: Body) => completion([{ name: "submitPlan", args: { coaching: placedIds(b).map((entity_id) => ({ entity_id, line: "One small step is plenty." })) } }]);
    // one tool per step, as gpt-oss does on Groq; every scripted step reports 20 tokens
    const groq = scriptedLlm([() => completion([ROUTE_ALL[0]]), () => completion([ROUTE_ALL[1]]), () => completion([ROUTE_ALL[2]]), coach], [], "groq");
    const events: AgentEvent[] = [];
    const plan = await runAgent({ qloo: replayClient(), case: MAYA, llms: [groq], routeTokenBudget: 60, onEvent: (e) => events.push(e) });
    expect(plan.slots.filter((s) => s.routedBy === "llm").map((s) => s.slot.day)).toEqual(["monday", "tuesday", "wednesday"]);
    expect(plan.slots.filter((s) => s.routedBy === "fallback")).toHaveLength(4);
    const fb = events.filter((e) => e.type === "llm_fallback");
    expect(fb).toEqual([expect.objectContaining({ stage: "route", from: "groq:openai/gpt-oss-120b", to: null, open: 4 })]);
    expect(traceLine(fb[0] as unknown as { type: string } & Record<string, unknown>)).toBe("LLM fallback groq:openai/gpt-oss-120b (spent its routing token budget) → deterministic route for 4 slots");
    // a budget stop is not a failure: no error recorded, and the same provider still coaches the week
    expect(plan.llmErrors).toEqual([]);
    expect(plan.coachedBy?.provider).toBe("groq");
    expect(plan.slots.filter((s) => s.card).every((s) => s.coachingBy === "llm")).toBe(true);
  });

  it("past its budget the primary hands the open slots to the next provider, not to the deterministic route", async () => {
    const coach = (b: Body) => completion([{ name: "submitPlan", args: { coaching: placedIds(b).map((entity_id) => ({ entity_id, line: "One small step is plenty." })) } }]);
    const groq = scriptedLlm([() => completion([ROUTE_ALL[0]]), () => completion([ROUTE_ALL[1]]), coach], [], "groq");
    const qwen = scriptedLlm([() => completion(ROUTE_ALL.slice(2)), coach]);
    const events: AgentEvent[] = [];
    const plan = await runAgent({ qloo: replayClient(), case: MAYA, llms: [groq, qwen], routeTokenBudget: 40, onEvent: (e) => events.push(e) });
    expect(plan.slots.every((s) => s.routedBy === "llm")).toBe(true);
    expect(plan.slots.filter((s) => s.llm === "groq:openai/gpt-oss-120b")).toHaveLength(2);
    expect(events.find((e) => e.type === "llm_fallback")).toMatchObject({ stage: "route", to: "qwen:qwen3.8-flash", open: 5 });
    expect(plan.llmErrors).toEqual([]);
  });
});

describe("a2a r09: routing credit and progress come from the model's own tool calls, not claimed.size", () => {
  const coach = (b: Body) => completion([{ name: "submitPlan", args: { coaching: placedIds(b).map((entity_id) => ({ entity_id, line: "One small step is plenty." })) } }]);
  /** a re-plan's kept card: the Monday at-home card of a deterministic week */
  async function keptMonday() {
    const w1 = await runAgent({ qloo: replayClient(), case: MAYA, llms: [] });
    return [{ card: w1.slots.find((s) => s.slot.day === "monday")!.card!, params: { rated: 8 } }];
  }

  it("a kept card does not credit a provider that failed before any tool call: both fail → no LLM named anywhere", async () => {
    const pinned = await keptMonday();
    const plan = await runAgent({ qloo: replayClient(), case: MAYA, llms: [failingLlm("qwen"), failingLlm("groq", 500)], pinned });
    expect(plan.slots.find((s) => s.slot.day === "monday")?.routedBy).toBe("kept");
    expect(plan.llm).toBeNull();
    const label = routingLabel(planDocFromAgent(plan, { caseId: "c", history: EMPTY_HISTORY, calls: 0 }));
    expect(label).not.toMatch(/qwen|groq/);
    expect(label).toContain("kept ×1");
  });

  it("Qwen fails before any tool call on a re-plan, Groq routes the open slots → the plan is credited to Groq", async () => {
    const pinned = await keptMonday();
    const groq = scriptedLlm([() => completion(ROUTE_ALL.slice(1)), coach], [], "groq");
    const plan = await runAgent({ qloo: replayClient(), case: MAYA, llms: [failingLlm("qwen"), groq], pinned });
    expect(plan.llm?.provider).toBe("groq");
    expect(plan.slots.filter((s) => s.routedBy === "llm").every((s) => s.llm?.startsWith("groq:"))).toBe(true);
  });

  it("re-routing slots Qloo still can't answer is progress, not 'no tool call'; the provider keeps its coaching seat", async () => {
    const outings = ROUTE_ALL.filter((c) => c.name !== "findAtHome");
    const stop = () => completion([], "Done.");
    // round 1 routes the week (outings come back Qloo-unavailable); rounds 2 and 3 re-route only those outings
    const llm = scriptedLlm([() => completion(ROUTE_ALL), stop, () => completion(outings), stop, () => completion(outings), stop, coach]);
    const plan = await runAgent({ qloo: replayClient([], true), case: MAYA, llms: [llm] });
    expect(plan.slots.filter((s) => s.slot.rung !== "home").every((s) => !s.card && /^Qloo unavailable/.test(s.empty ?? ""))).toBe(true);
    expect(plan.llmErrors.filter((e) => /no progress/.test(e.error))).toEqual([]);
    expect(plan.coachedBy?.provider).toBe("qwen");
  });
});

describe("a2a r09: the coaching race is won by a usable call only", () => {
  it("a fast submitPlan with no line for a placed card does not abort the provider writing real lines", async () => {
    const coach = (b: Body) => completion([{ name: "submitPlan", args: { coaching: placedIds(b).map((entity_id) => ({ entity_id, line: "One small step is plenty." })) } }]);
    const qwen = scriptedLlm([() => completion(ROUTE_ALL), () => completion([{ name: "submitPlan", args: { coaching: [] } }])]);
    const slowGroq = scriptedLlm([(b) => new Promise<Response>((r) => setTimeout(() => r(coach(b)), 50)) as unknown as Response], [], "groq");
    const plan = await runAgent({ qloo: replayClient(), case: MAYA, llms: [qwen, slowGroq], routeTokenBudget: 1e6 });
    expect(plan.coachedBy?.provider).toBe("groq");
    expect(plan.slots.filter((s) => s.card).every((s) => s.coachingBy === "llm")).toBe(true);
    expect(llmFailure("Error: the model's submitPlan named no placed card")).toBe("no usable coaching line");
  });
});

describe("a2a r10: the race and the truth boundary agree on what a usable line is", () => {
  it("a fast call whose every placed-card line mentions drinking loses to the provider writing usable lines", async () => {
    const coach = (b: Body) => completion([{ name: "submitPlan", args: { coaching: placedIds(b).map((entity_id) => ({ entity_id, line: "One small step is plenty." })) } }]);
    const qwen = scriptedLlm([() => completion(ROUTE_ALL), (b) => completion([{ name: "submitPlan", args: { coaching: placedIds(b).map((entity_id) => ({ entity_id, line: "Grab a beer after." })) } }])]);
    const slowGroq = scriptedLlm([(b) => new Promise<Response>((r) => setTimeout(() => r(coach(b)), 50)) as unknown as Response], [], "groq");
    const plan = await runAgent({ qloo: replayClient(), case: MAYA, llms: [qwen, slowGroq], routeTokenBudget: 1e6 });
    expect(plan.coachedBy?.provider).toBe("groq");
    expect(plan.dropped.filter((d) => d.rule === "COACH-ALC")).toEqual([]);
    expect(plan.slots.filter((s) => s.card).every((s) => s.coachingBy === "llm")).toBe(true);
    expect(plan.llmErrors).toEqual([]);
  });

  it("usableLines applies the boundary's per-line rules without recording anything", () => {
    const cards = [{ entity_id: "A", name: "Prospect Park", rung: "solo" as const }, { entity_id: "B", name: "Phoebe Bridgers", rung: "home" as const }];
    const lines = [
      { entity_id: "A", line: "Grab a beer after." },
      { entity_id: "A", line: "Walk for two hours." },
      { entity_id: "B", line: "Then try Prospect Park." },
      { entity_id: "Z", line: "One small step is plenty." },
      { entity_id: "B", line: "One small step is plenty." },
    ];
    expect(usableLines(cards, lines, ["Prospect Park", "Phoebe Bridgers"])).toEqual([{ entity_id: "B", line: "One small step is plenty." }]);
  });
});

describe("a2a r09: provider errors drop account ids before the trace, the stored plan and the plan API", () => {
  it("a Groq 429 naming the organization reaches neither the SSE events nor llm_errors with the id; older stored plans are redacted on read", async () => {
    const msg = "Rate limit reached for model `openai/gpt-oss-120b` in organization `org_01testorgid42` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 7900, Requested 1462.";
    const groq = makeLlm("groq", { GROQ_API_KEY: "k" }, (async () => new Response(JSON.stringify({ error: { message: msg } }), { status: 429, headers: { "content-type": "application/json" } })) as unknown as typeof fetch)!;
    const events: AgentEvent[] = [];
    const plan = await runAgent({ qloo: replayClient(), case: MAYA, llms: [groq], onEvent: (e) => events.push(e) });
    expect(plan.llmErrors.length).toBeGreaterThan(0);
    expect(plan.llmErrors[0]!.error).toContain("organization `org_…`");
    expect(JSON.stringify(events)).not.toContain("org_01testorgid42");
    const stored = planDocFromAgent({ ...plan, llmErrors: [{ provider: "groq", error: msg }] }, { caseId: "c", history: EMPTY_HISTORY, calls: 0 });
    expect(stored.llm_errors[0]!.error).not.toContain("org_01testorgid42");
  }, 15_000);
});
