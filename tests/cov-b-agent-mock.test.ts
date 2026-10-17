import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Card, ToolResult } from "../lib/plan";

// runAgent's own bookkeeping (pinned cards, empty reasons, hung tools) is exercised against stubbed slot tools, which
// lets a tool return the shapes the live tools never produce (an empty result with no reason, a non-Error throw, a call
// that never finishes). The tools themselves are covered by tests/plan.test.ts.
vi.mock("../lib/plan", async (orig) => ({ ...(await orig<typeof import("../lib/plan")>()), findAtHome: vi.fn(), findOutings: vi.fn(), placeSocial: vi.fn(), diagnoseEmpty: vi.fn() }));

// generateText passes through to the real AI SDK unless a test installs its own behaviour (an SDK that gives up while
// its tool calls are still running, which the real one never does)
vi.mock("ai", async (orig) => {
  const real = await orig<typeof import("ai")>();
  return { ...real, generateText: vi.fn((...a: Parameters<typeof real.generateText>) => real.generateText(...a)) };
});

import { generateText } from "ai";
import { assembleCoaching, cardsWithoutEntity, coachRace, runAgent, templateCoaching, type AgentEvent, type AgentPlan, type AgentSlot } from "../lib/agent";
import { makeLlm, type LlmHandle } from "../lib/llm";
import * as planLib from "../lib/plan";
import type { QlooClient } from "../lib/qloo";
import { MAYA } from "./replay";

const findAtHome = vi.mocked(planLib.findAtHome);
const findOutings = vi.mocked(planLib.findOutings);
const placeSocial = vi.mocked(planLib.placeSocial);
const diagnoseEmpty = vi.mocked(planLib.diagnoseEmpty);
const qloo = {} as QlooClient;

const cardFor = (id: string, slot: planLib.SlotSpec): Card => ({ slot, hour: slot.hour, rung: slot.rung, entity_id: id, name: `Card ${id}`, entityType: slot.rung === "home" ? `urn:entity:${slot.homeType ?? "artist"}` : "urn:entity:place", affinity: 0.5, tags: [], why: [], verdict: "PASS", checks: [] });
const found = (id: string, slot: planLib.SlotSpec): ToolResult => ({ card: cardFor(id, slot), refusals: [], review: [], returned: 1 });
const nothing = (empty?: string): ToolResult => ({ card: null, refusals: [], review: [], returned: 0, ...(empty ? { empty } : {}) });

beforeEach(() => {
  for (const f of [findAtHome, findOutings, placeSocial, diagnoseEmpty]) f.mockReset();
  findAtHome.mockImplementation(async (_c, slot) => found(`H-${slot.day}`, slot));
  findOutings.mockImplementation(async (_c, slot) => found(`O-${slot.day}`, slot));
  placeSocial.mockImplementation(async (_c, slot) => found(`S-${slot.day}`, slot));
  diagnoseEmpty.mockResolvedValue(null);
});

describe("deterministic route over stubbed tools", () => {
  it("an empty result without a reason is stored with the default reason; a thrown non-Error is a tool failure", async () => {
    findOutings.mockImplementation(async (_c, slot) => {
      if (slot.day === "thursday") return nothing();
      throw "not an Error";
    });
    placeSocial.mockResolvedValue(nothing("no heatmap"));
    const events: AgentEvent[] = [];
    const plan = await runAgent({ qloo, case: MAYA, llms: [], onEvent: (e) => events.push(e) });
    const byDay = Object.fromEntries(plan.slots.map((s) => [s.slot.day, s.empty]));
    expect(byDay.thursday).toBe("no verified candidate");
    expect(byDay.saturday).toBe("tool failed (error) — slot left empty");
    expect(byDay.sunday).toBe("no heatmap");
    // an empty outing under optional filters is probed once; a failed or outage slot is not
    expect(diagnoseEmpty.mock.calls.map((c) => c[1].day).sort()).toEqual(["sunday", "thursday"]);
    expect(plan.slots.find((s) => s.slot.day === "thursday")).not.toHaveProperty("relax");
  });

  it("a diagnosis is attached to the empty outing it probed", async () => {
    findOutings.mockResolvedValue(nothing("none"));
    diagnoseEmpty.mockResolvedValue({ quiet: 2 });
    const plan = await runAgent({ qloo, case: MAYA, llms: [] });
    expect(plan.slots.filter((s) => s.relax).map((s) => [s.slot.day, s.relax])).toEqual([["thursday", { quiet: 2 }], ["saturday", { quiet: 2 }]]);
  });
});

describe("pinned (kept) cards", () => {
  const monday = { day: "monday", hour: 19, rung: "home", homeType: "artist" } as const;
  const pin = (id: string, slot: planLib.SlotSpec, params?: Record<string, unknown>) => ({ card: cardFor(id, slot), ...(params ? { params } : {}) });

  it("each pinned card takes its own day and rung; a second card for the same day or a rung the ladder does not have there is ignored", async () => {
    const events: AgentEvent[] = [];
    const plan = await runAgent({
      qloo,
      case: MAYA,
      llms: [],
      pinned: [
        pin("K-mon", monday, { rated: 9 }),
        pin("K-mon-again", monday),
        pin("K-wrong-rung", { day: "monday", hour: 19, rung: "solo" }),
        pin("K-thu", { day: "thursday", hour: 18, rung: "solo" }),
        pin("K-sun", { day: "sunday", hour: 14, rung: "social" }),
      ],
      onEvent: (e) => events.push(e),
    });
    const kept = plan.slots.filter((s) => s.routedBy === "kept");
    expect(kept.map((s) => [s.slot.day, s.card!.entity_id, s.tool])).toEqual([["monday", "K-mon", "findAtHome"], ["thursday", "K-thu", "findOutings"], ["sunday", "K-sun", "placeSocial"]]);
    expect(kept.map((s) => s.params)).toEqual([{ day: "monday", kept: true, rated: 9 }, { day: "thursday", kept: true }, { day: "sunday", kept: true }]);
    // the kept days are never routed again
    expect(findAtHome.mock.calls.map((c) => c[1].day)).not.toContain("monday");
    expect(findOutings.mock.calls.map((c) => c[1].day)).toEqual(["saturday"]);
    expect(placeSocial).not.toHaveBeenCalled();
  });

  it("a week whose every slot is kept has nothing to route: the model is never called", async () => {
    const slots = [monday, { day: "tuesday", hour: 19, rung: "home", homeType: "podcast" }, { day: "wednesday", hour: 19, rung: "home", homeType: "book" }, { day: "thursday", hour: 18, rung: "solo" }, { day: "friday", hour: 19, rung: "home", homeType: "tv_show" }, { day: "saturday", hour: 11, rung: "solo" }, { day: "sunday", hour: 14, rung: "social" }] as const;
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const llm = makeLlm("qwen", { QWEN_API_KEY: "k" }, fetchImpl as unknown as typeof fetch)!;
    const plan = await runAgent({ qloo, case: MAYA, llms: [llm], pinned: slots.map((s) => pin(`K-${s.day}`, s)) });
    expect(plan.slots.every((s) => s.routedBy === "kept")).toBe(true);
    expect(plan.llm).toBeNull();
    expect(findAtHome).not.toHaveBeenCalled();
  });
});

type ToolMap = Record<string, { execute?: (input: unknown, opts: unknown) => unknown }>;
const realGenerate = vi.mocked(generateText).getMockImplementation()!;
const llmStub = (): LlmHandle => makeLlm("qwen", { QWEN_API_KEY: "k" }, (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch)!;
const startCalls = (tools: ToolMap, calls: [string, unknown][]) => calls.map(([name, input]) => tools[name]!.execute!(input, { toolCallId: name, messages: [] }));

describe("an SDK that gives up while tool calls are still running", () => {
  beforeEach(() => {
    vi.mocked(generateText).mockImplementation(realGenerate);
  });

  it("a claimed slot whose tool never finished stays on the week as 'not routed', with the tool it would have used", async () => {
    const hang = () => new Promise<ToolResult>(() => {});
    findAtHome.mockImplementation(hang);
    findOutings.mockImplementation(hang);
    placeSocial.mockImplementation(hang);
    vi.mocked(generateText).mockImplementation((async (o: { tools: ToolMap }) => {
      startCalls(o.tools, [
        ["findAtHome", { day: "monday", type: "artist" }],
        ["findAtHome", { day: "tuesday", type: "podcast" }],
        ["findAtHome", { day: "wednesday", type: "book" }],
        ["findOutings", { day: "thursday" }],
        ["findAtHome", { day: "friday", type: "tv_show" }],
        ["findOutings", { day: "saturday" }],
        ["placeSocial", { day: "sunday" }],
      ]);
      throw new Error("aborted");
    }) as never);
    const plan = await runAgent({ qloo, case: MAYA, llms: [llmStub()] });
    expect(plan.slots.map((s) => [s.slot.day, s.tool, s.card, s.routedBy])).toEqual([
      ["monday", "findAtHome", null, "fallback"],
      ["tuesday", "findAtHome", null, "fallback"],
      ["wednesday", "findAtHome", null, "fallback"],
      ["thursday", "findOutings", null, "fallback"],
      ["friday", "findAtHome", null, "fallback"],
      ["saturday", "findOutings", null, "fallback"],
      ["sunday", "placeSocial", null, "fallback"],
    ]);
    expect(plan.slots.every((s) => s.empty === "not routed: its tool call did not finish" && Object.keys(s.params).join() === "day")).toBe(true);
    expect(plan.llmErrors).toHaveLength(1);
  });

  it("a provider whose calls report no token usage at all is never over its routing budget", async () => {
    // one slot routed per round, no call-end report: the budget check finds no spend recorded and the loop keeps going
    let round = 0;
    vi.mocked(generateText).mockImplementation((async (o: { tools: ToolMap }) => {
      const days = ["monday", "tuesday"] as const;
      const day = days[round++];
      if (day) await startCalls(o.tools, [["findAtHome", { day, type: "artist" }]])[0];
      return {};
    }) as never);
    const events: AgentEvent[] = [];
    const plan = await runAgent({ qloo, case: MAYA, llms: [llmStub()], onEvent: (e) => events.push(e) });
    expect(plan.slots.filter((s) => s.routedBy === "llm").map((s) => s.slot.day)).toEqual(["monday", "tuesday"]);
    expect(events.some((e) => e.type === "llm_fallback" && /token budget/.test(e.error))).toBe(false);
    // the third round made no progress: that provider is out and the deterministic route takes the rest
    expect(plan.llmErrors.map((e) => e.error)).toEqual([expect.stringContaining("no progress")]);
    expect(plan.slots.filter((s) => s.routedBy === "fallback")).toHaveLength(5);
  });
});

describe("routing tool calls as the model makes them", () => {
  beforeEach(() => {
    vi.mocked(generateText).mockImplementation(realGenerate);
  });

  it("wrong-rung and repeated calls are refused with the reason; optional arguments reach the tool and the params", async () => {
    let results: unknown[] = [];
    let calls = 0;
    vi.mocked(generateText).mockImplementation((async (o: { tools: ToolMap }) => {
      if (calls++ === 0) {
        results = await Promise.all(
          startCalls(o.tools, [
            ["findAtHome", { day: "thursday", type: "artist" }],
            ["placeSocial", { day: "monday" }],
            ["findAtHome", { day: "monday", type: "book", take: 4 }],
            ["findAtHome", { day: "monday", type: "book" }],
            ["placeSocial", { day: "sunday", hour: 15 }],
          ]),
        );
      }
      return {};
    }) as never);
    const events: AgentEvent[] = [];
    const plan = await runAgent({ qloo, case: MAYA, llms: [llmStub()], onEvent: (e) => events.push(e) });
    expect(results).toMatchObject([
      { ok: false, error: "thursday is a solo slot, not home" },
      { ok: false, error: "monday is a home slot, not social" },
      { ok: true, day: "monday" },
      { ok: false, error: "monday is already filled" },
      { ok: true, day: "sunday" },
    ]);
    expect(events.filter((e) => e.type === "tool_rejected").map((e) => (e as { reason: string }).reason)).toEqual(["thursday is a solo slot, not home", "monday is a home slot, not social", "monday is already filled"]);
    expect(findAtHome.mock.calls.find((c) => c[1].day === "monday")![3]).toBe(4);
    const sunday = plan.slots.find((s) => s.slot.day === "sunday")!;
    expect(sunday).toMatchObject({ routedBy: "llm", params: { day: "sunday", hour: 15 } });
    expect(plan.slots.find((s) => s.slot.day === "monday")!.params).toEqual({ day: "monday", type: "book", take: 4 });
  });

  it("a call-end report without token usage counts as zero tokens and null in the trace", async () => {
    let calls = 0;
    vi.mocked(generateText).mockImplementation((async (o: { tools: ToolMap; onLanguageModelCallEnd: (e: unknown) => void }) => {
      if (calls++ === 0) o.onLanguageModelCallEnd({ performance: { responseTimeMs: 7.4 }, content: [{ type: "text" }, { type: "tool-call", toolName: "findAtHome" }, { type: "tool-call" }], finishReason: "tool-calls", usage: {} });
      return {};
    }) as never);
    const events: AgentEvent[] = [];
    await runAgent({ qloo, case: MAYA, llms: [llmStub()], onEvent: (e) => events.push(e) });
    expect(events.find((e) => e.type === "llm")).toMatchObject({ step: 1, ms: 7, toolCalls: ["findAtHome"], finishReason: "tool-calls", inputTokens: null, outputTokens: null });
  });

  it("a routing budget under two seconds leaves no time to ask the model: the deterministic route takes the week", async () => {
    vi.mocked(generateText).mockClear();
    const plan = await runAgent({ qloo, case: MAYA, llms: [llmStub()], llmBudgetMs: 1000 });
    const systems = vi.mocked(generateText).mock.calls.map((c) => String((c[0] as { system?: string }).system));
    expect(systems.length).toBeGreaterThan(0); // the coaching call still happens
    expect(systems.some((t) => t.includes("Step 1"))).toBe(false); // but no routing call does
    expect(plan.slots.every((s) => s.routedBy === "fallback")).toBe(true);
    expect(plan.llm).toBeNull();
  });
});

describe("coachRace edges", () => {
  beforeEach(() => {
    vi.mocked(generateText).mockImplementation(realGenerate);
  });

  it("nothing to race, or no time to race in: no call is made", async () => {
    vi.mocked(generateText).mockClear();
    expect(await coachRace({ llms: [], prompt: "p", windowMs: 6000 })).toEqual({ lines: null, by: null, errors: [], rejected: [] });
    expect(await coachRace({ llms: [llmStub()], prompt: "p", windowMs: 1499 })).toEqual({ lines: null, by: null, errors: [], rejected: [] });
    expect(generateText).not.toHaveBeenCalled();
  });

  it("a model that answers without calling submitPlan fails its attempt with that reason; no call-end hook is passed unless asked for", async () => {
    vi.mocked(generateText).mockImplementation((async () => ({})) as never);
    const r = await coachRace({ llms: [llmStub()], prompt: "p", windowMs: 6000 });
    expect(r).toMatchObject({ lines: null, by: null, rejected: [], errors: [{ provider: "qwen", error: expect.stringContaining("the model did not call submitPlan") }] });
    expect(Object.keys(vi.mocked(generateText).mock.calls[0]![0] as object)).not.toContain("onLanguageModelCallEnd");
  });
});

describe("coaching helpers", () => {
  const card = (o: Partial<Card>): Card => ({ ...cardFor("X", { day: "monday", hour: 19, rung: "home" }), ...o });

  it("templateCoaching derives the at-home domain from the entity type when none is given", () => {
    expect(templateCoaching(card({ entityType: "urn:entity:podcast", name: "Pod" }))).toBe("Play ten minutes of one Pod episode you pick.");
    expect(templateCoaching(card({ entityType: "urn:entity:book", name: "Bk" }))).toBe("Read ten minutes of Bk, any page you like.");
    expect(templateCoaching(card({ entityType: "urn:entity:podcast", name: "Pod" }), "artist")).toBe("Put on one Pod song you choose and give it ten minutes.");
  });

  it("a second coaching line for the same card is dropped as COACH-DUPLICATE and the first stays", () => {
    const slot: AgentSlot = { slot: { day: "monday", hour: 19, rung: "home", homeType: "artist" }, card: card({ entity_id: "E1", name: "Alpha Band" }), routedBy: "llm", tool: "findAtHome", params: {} };
    const dropped = assembleCoaching([slot], [{ entity_id: "E1", line: "Put on one song." }, { entity_id: "E1", line: "Put on two songs." }], []);
    expect(dropped).toEqual([{ rule: "COACH-DUPLICATE", entity_id: "E1", detail: "second coaching line for the same card" }]);
    expect(slot).toMatchObject({ coaching: "Put on one song.", coachingBy: "llm" });
  });

  it("cardsWithoutEntity counts placed cards that carry no entity id", () => {
    const slots = [{ card: card({ entity_id: "A" }) }, { card: card({ entity_id: "" }) }, { card: null }] as unknown as AgentSlot[];
    expect(cardsWithoutEntity({ slots } as AgentPlan)).toBe(1);
  });
});
