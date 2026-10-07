import { describe, expect, it } from "vitest";
import { assembleCoaching, runAgent, templateCoaching, type AgentEvent, type AgentSlot } from "../lib/agent";
import { llmChainFromEnv, makeLlm, type LlmHandle } from "../lib/llm";
import type { QlooParams } from "../lib/qloo";
import { ALCOHOL_EXCLUDE_14 } from "../lib/tags";
import type { Card } from "../lib/plan";
import { MAYA, replayClient } from "./replay";

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

/** tool results the model has seen so far, parsed from the request messages */
function toolResults(b: Body): { entity_id?: string; name?: string }[] {
  const out: { entity_id?: string; name?: string }[] = [];
  for (const m of b.messages) {
    if (m.role !== "tool") continue;
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    try {
      out.push(JSON.parse(text));
    } catch {
      for (const id of text.matchAll(/"entity_id":"([^"]+)"/g)) out.push({ entity_id: id[1] });
    }
  }
  return out;
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
    const llm = scriptedLlm([() => completion(ROUTE_ALL), (b) => completion([{ name: "submitPlan", args: { coaching: toolResults(b).filter((r) => r.entity_id).map((r) => ({ entity_id: r.entity_id, line: "Ten minutes is plenty; stop whenever you like." })) } }])], bodies);
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
        const ids = toolResults(b).filter((r) => r.entity_id).map((r) => r.entity_id!);
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

  it("LLM fallback switch: the primary fails, the secondary provider routes the week", async () => {
    const events: AgentEvent[] = [];
    const plan = await runAgent({ qloo: replayClient(), case: MAYA, llms: [failingLlm("qwen"), scriptedLlm([() => completion(ROUTE_ALL), () => completion([{ name: "submitPlan", args: { coaching: [] } }])], [], "groq")], onEvent: (e) => events.push(e) });
    expect(events.find((e) => e.type === "llm_fallback")).toMatchObject({ from: "qwen:qwen3.8-flash", to: "groq:openai/gpt-oss-120b" });
    expect(plan.llm?.provider).toBe("groq");
    expect(plan.llmErrors).toHaveLength(1);
    expect(plan.slots.every((s) => s.routedBy === "llm")).toBe(true);
  });

  it("every provider down: the week is routed deterministically by the same tools, never by model text", async () => {
    const plan = await runAgent({ qloo: replayClient(), case: MAYA, llms: [failingLlm("qwen"), failingLlm("groq", 500)] });
    expect(plan.llm).toBeNull();
    expect(plan.slots).toHaveLength(7);
    expect(plan.slots.every((s) => s.routedBy === "fallback")).toBe(true);
    expect(plan.slots.filter((s) => s.card).every((s) => s.coachingBy === "template")).toBe(true);
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
