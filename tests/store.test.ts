import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../lib/agent";
import { parseSse, sseResponse } from "../lib/http";
import { makeLlm } from "../lib/llm";
import { EMPTY_HISTORY } from "../lib/plan";
import { caseFromSeed, runPlanForCase, SEEDS } from "../lib/service";
import { BlobStore, callsDoc, CaseDoc, caseRowFromDoc, MemoryStore, PlanDoc, planDocFromAgent, storeFromEnv, weekPlanFromDoc } from "../lib/store";
import type { QlooCallLog, QlooClient } from "../lib/qloo";
import { MAYA, replayClient } from "./replay";
import { POST as seedRoute } from "../app/api/cases/seed/[slug]/route";
import { GET as getCaseRoute } from "../app/api/cases/[id]/route";
import { GET as getPlanRoute } from "../app/api/plans/[id]/route";
import { POST as intakeRoute } from "../app/api/cases/route";

/** deterministic route only: every LLM provider "down", so these tests exercise persistence, not routing */
const downLlm = () => makeLlm("qwen", { QWEN_API_KEY: "k" }, (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch)!;

/** replay client that also reports calls, like the live client does */
const loggingReplay = (onCall: (l: QlooCallLog) => void): QlooClient => {
  const inner = replayClient();
  return {
    async insights(p: Parameters<QlooClient["insights"]>[0]) {
      const r = await inner.insights(p);
      onCall({ path: "/v2/insights", params: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)])), status: 200, ms: 1, n_results: r.results.entities?.length ?? r.results.heatmap?.length ?? 0, attempts: 1, at: new Date().toISOString() });
      return r;
    },
  } as unknown as QlooClient;
};

describe("persistence (lib/store.ts)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("seeded Maya clones into a schema-valid case whose row matches the D2 case", () => {
    const c = caseFromSeed("maya")!;
    expect(c.is_seed).toBe(true);
    const row = caseRowFromDoc(c);
    expect(row).toMatchObject({ lon: MAYA.lon, lat: MAYA.lat, energy: 1, priceMax: 2, maxMeters: 1500, inRecovery: false });
    expect(row.loves.map((l) => l.qlooId)).toEqual(MAYA.loves.map((l) => l.qlooId));
    expect(SEEDS).toHaveLength(20);
    expect(caseFromSeed("nobody")).toBeNull();
  });

  it("a plan persists and reloads as the same week (D4 gate), with its Qloo call log beside it", async () => {
    const store = new MemoryStore();
    const c = caseFromSeed("maya")!;
    await store.putCase(c);
    const saved = await runPlanForCase({ store, caseId: c.id, qloo: loggingReplay, llms: [downLlm()] });
    const reloaded = await store.getPlan(saved.id);
    expect(reloaded).toEqual(saved);
    expect(reloaded!.cards.length + reloaded!.empty_slots.length).toBe(7);
    expect(reloaded!.cards.every((x) => x.qloo_entity_id.length > 0)).toBe(true);
    const calls = await store.getCalls(saved.id);
    expect(calls!.calls.length).toBe(saved.qloo_calls);
    expect(JSON.stringify(calls)).not.toMatch(/api[-_]?key/i);
    expect(await store.listPlanIds()).toEqual([saved.id]);
  });

  it("stored plan → in-memory week round trip keeps cards, hours, moves and refusals (toggle / re-plan input)", async () => {
    const plan = await runAgent({ qloo: replayClient(), case: MAYA, llms: [] });
    const doc = planDocFromAgent(plan, { caseId: crypto.randomUUID(), history: EMPTY_HISTORY, calls: 0 });
    const week = weekPlanFromDoc(PlanDoc.parse(JSON.parse(JSON.stringify(doc))));
    expect(week.slots.map((s) => s.slot.day)).toEqual(plan.slots.map((s) => s.slot.day));
    for (const [i, s] of week.slots.entries()) {
      const orig = plan.slots[i].card;
      expect(s.card?.entity_id).toBe(orig?.entity_id);
      expect(s.card?.hour).toBe(orig?.hour);
      expect(s.card?.movedFrom).toBe(orig?.movedFrom);
      expect(s.card?.why).toEqual(orig?.why);
    }
    expect(week.refusals.length).toBe(plan.refusals.length);
  });

  it("I1 at the storage layer: a card without a Qloo entity_id is rejected by the schema", () => {
    const plan = PlanDoc.parse(planDocFromAgent({ week: 1, slots: [], refusals: [], review: [], calls: [], llm: null, llmSteps: 0, llmMs: 0, llmErrors: [], dropped: [], latencyMs: 1 }, { caseId: "c", history: EMPTY_HISTORY, calls: 0 }));
    const bad = { ...plan, cards: [{ id: "x", plan_id: plan.id, day: 0, day_name: "monday", hour: 19, slot_hour: 19, rung: "home", qloo_entity_id: "", name: "Invented", entity_type: "", affinity: 0, explain_json: [], tags: [], checks: [], verdict: "PASS" }] };
    expect(() => PlanDoc.parse(bad)).toThrow();
  });

  it("rejects malformed ids (no path traversal into other blobs) and invalid case rows", async () => {
    const store = new MemoryStore();
    await expect(store.getPlan("../cases/x")).rejects.toThrow("invalid id");
    expect(() => CaseDoc.parse({ ...caseFromSeed("maya")!, energy: 4 })).toThrow();
    expect(() => CaseDoc.parse({ ...caseFromSeed("maya")!, point_wkt: "POINT(1 2); DROP" })).toThrow();
  });

  it("storeFromEnv: Blob with a token; in-memory only off Vercel; refused on a deployment without a token", () => {
    expect(storeFromEnv({ BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_x" })).toBeInstanceOf(BlobStore);
    expect(storeFromEnv({}).kind).toBe("memory");
    expect(() => storeFromEnv({ VERCEL: "1" })).toThrow(/BLOB_READ_WRITE_TOKEN/);
  });

  it("call log documents keep params but never a key", () => {
    const d = callsDoc("6f1c1c1e-0000-4000-8000-000000000000", [{ path: "/search", params: { query: "Fleabag" }, status: 200, ms: 300, n_results: 3, attempts: 1, at: "2026-10-07T00:00:00Z" }]);
    expect(d.calls[0]).toEqual({ path: "/search", params_json: { query: "Fleabag" }, status: 200, ms: 300, n_results: 3, at: "2026-10-07T00:00:00Z" });
  });
});

describe("API routes (in-memory store, no network)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

  it("POST /api/cases/seed/maya → GET /api/cases/:id returns the same case; unknown seeds 404", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    const r = await seedRoute(new Request("http://x/api/cases/seed/maya", { method: "POST" }), ctx({ slug: "maya" }));
    expect(r.status).toBe(201);
    const { case: c } = await r.json();
    const g = await getCaseRoute(new Request(`http://x/api/cases/${c.id}`), ctx({ id: c.id }));
    expect((await g.json()).case).toEqual(c);
    expect((await seedRoute(new Request("http://x", { method: "POST" }), ctx({ slug: "nobody" }))).status).toBe(404);
  });

  it("POST /api/cases validates intake and defaults the radius from energy", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    const body = { label: "Test", lon: -73.95, lat: 40.7, energy: 2, loves: [{ text: "Fleabag", qloo_id: "878680F2-2C8D-4D7A-8288-BEA75D38A843", qloo_kind: "entity" }, { text: "ramen", qloo_id: "urn:tag:genre:place:restaurant:ramen", qloo_kind: "tag" }, { text: "Phoebe Bridgers", qloo_id: "AFBC71A7-9439-4AB0-AB68-D14B11AAF836", qloo_kind: "entity" }] };
    const ok = await intakeRoute(new Request("http://x/api/cases", { method: "POST", body: JSON.stringify(body) }));
    expect(ok.status).toBe(201);
    expect((await ok.json()).case).toMatchObject({ max_meters: 3000, price_max: 2, in_recovery: false, is_seed: false });
    const bad = await intakeRoute(new Request("http://x/api/cases", { method: "POST", body: JSON.stringify({ ...body, energy: 9 }) }));
    expect(bad.status).toBe(400);
  });

  it("GET /api/plans/:id 404s for an unknown plan and 400s for a malformed id", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    expect((await getPlanRoute(new Request("http://x"), ctx({ id: crypto.randomUUID() }))).status).toBe(404);
    expect((await getPlanRoute(new Request("http://x"), ctx({ id: "nope" }))).status).toBe(400);
  });

  it("the plan stream sends open → start → tool… → plan, and the streamed plan is the stored plan", async () => {
    const store = new MemoryStore();
    const c = caseFromSeed("maya")!;
    await store.putCase(c);
    const res = sseResponse(async (send) => {
      const plan = await runPlanForCase({ store, caseId: c.id, qloo: loggingReplay, llms: [downLlm()], onEvent: (e) => send(e.type, e) });
      send("plan", { plan });
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const frames = parseSse(await res.text());
    const kinds = frames.map((f) => f.event);
    expect(kinds[0]).toBe("open");
    expect(kinds[1]).toBe("start");
    expect(kinds).toContain("qloo");
    expect(kinds.filter((k) => k === "tool")).toHaveLength(7);
    expect(kinds.at(-1)).toBe("plan");
    const streamed = (frames.at(-1)!.data as { plan: PlanDoc }).plan;
    expect(await store.getPlan(streamed.id)).toEqual(streamed);
  });

  it("an unknown case streams an error event (404) instead of a plan", async () => {
    const res = sseResponse(async (send) => {
      await runPlanForCase({ store: new MemoryStore(), caseId: crypto.randomUUID(), qloo: loggingReplay, llms: [] });
      send("plan", {});
    });
    const frames = parseSse(await res.text());
    expect(frames.at(-1)).toMatchObject({ event: "error", data: { status: 404 } });
  });
});
