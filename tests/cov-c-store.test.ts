import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentPlan, AgentSlot } from "../lib/agent";
import { EMPTY_HISTORY, type WeekPlan } from "../lib/plan";
import { caseFromSeed, runPlanForCase } from "../lib/service";
import {
  BlobStore,
  callsDoc,
  caseRowFromDoc,
  CaseDoc,
  envKeyPrefix,
  FailoverStore,
  MemoryStore,
  PlanDoc,
  planDocFromAgent,
  planDocFromToggle,
  RedisStore,
  storeFromEnv,
  StoreUnavailable,
  weekPlanFromDoc,
  cardFromDoc,
  type RunDoc,
  type Store,
} from "../lib/store";
import { FakeRedis } from "./fake-redis";
import { replayClient } from "./replay";

// No request leaves the test: the Blob SDK is an in-memory object store with ETag preconditions.
const blob = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), list: vi.fn() }));
vi.mock("@vercel/blob", async (importOriginal) => ({ ...(await importOriginal<typeof import("@vercel/blob")>()), get: blob.get, put: blob.put, list: blob.list }));

const streamOf = (text: string) => new Response(text).body!;
const iso = "2026-10-08T00:00:00.000Z";
const runIn = (caseId: string, extra: Partial<RunDoc> = {}) => ({ case_id: caseId, status: "running" as const, plan_id: null, started_at: iso, updated_at: iso, ...extra });

/** a week the real agent path produced, to borrow real Cards from */
async function realWeek() {
  const store = new MemoryStore();
  const c = caseFromSeed("maya")!;
  await store.putCase(c);
  const plan = await runPlanForCase({ store, caseId: c.id, qloo: () => replayClient(), llms: [] });
  return { c, plan, cards: plan.cards.map(cardFromDoc) };
}

describe("cov-c store: mapping (caseRowFromDoc, planDocFromAgent, planDocFromToggle, weekPlanFromDoc)", () => {
  it("caseRowFromDoc carries a love's entityType and name only when stored", () => {
    const c = caseFromSeed("maya")!;
    const bare = CaseDoc.parse({ ...c, loves: [{ id: "a", text: "x", qloo_id: "q1", qloo_kind: "tag" }, { id: "b", text: "y", qloo_id: "q2", qloo_kind: "entity", entity_type: "urn:entity:artist", name: "Y" }] });
    expect(caseRowFromDoc(bare).loves).toEqual([
      { text: "x", qlooId: "q1", kind: "tag" },
      { text: "y", qlooId: "q2", kind: "entity", entityType: "urn:entity:artist", name: "Y" },
    ]);
  });

  it("planDocFromAgent maps coach, routing, empty-slot and refusal options both present and absent", async () => {
    const { cards } = await realWeek();
    const card = cards[0]!;
    const base: Omit<AgentPlan, "slots" | "refusals" | "coachedBy"> = { week: 1, review: [], calls: [], llm: null, llmSteps: 0, llmMs: 0, llmErrors: [], dropped: [], latencyMs: 1 };
    const full: AgentSlot[] = [
      { slot: card.slot, card, routedBy: "llm", llm: "qwen:m", tool: "findOutings", params: { day: "monday" }, coaching: "Go.", coachingBy: "llm" },
      { slot: { day: "tuesday", hour: 10, rung: "solo" }, card: null, routedBy: "fallback", tool: "findOutings", params: {}, empty: "nothing open", relax: { quiet: 2 } },
    ];
    const bare: AgentSlot[] = [
      { slot: card.slot, card, routedBy: "fallback", tool: "findOutings", params: {} },
      { slot: { day: "tuesday", hour: 10, rung: "solo" }, card: null, routedBy: "fallback", tool: "findOutings", params: {} },
    ];
    const refusal = { day: "monday" as const, hour: 9, entity_id: "e", name: "N", rule: "R-OPEN", detail: "d", verdict: "REFUSE" as const };
    const a = planDocFromAgent({ ...base, slots: full, coachedBy: { provider: "groq", model: "m" }, refusals: [{ ...refusal, movedTo: 11, struckByToggle: true }] }, { caseId: "c", history: EMPTY_HISTORY, calls: 0 });
    expect(a.coach_llm).toBe("groq:m");
    expect([a.cards[0]!.coaching, a.cards[0]!.coaching_by, a.cards[0]!.routed_llm]).toEqual(["Go.", "llm", "qwen:m"]);
    expect(a.empty_slots[0]).toMatchObject({ reason: "nothing open", relax: { quiet: 2 } });
    expect(a.refusals[0]).toMatchObject({ moved_to: 11, struck_by_toggle: true });
    const b = planDocFromAgent({ ...base, slots: bare, refusals: [refusal] }, { caseId: "c", history: EMPTY_HISTORY, calls: 0 });
    expect(b.coach_llm).toBeNull();
    expect(b.cards[0]!.coaching).toBe("");
    expect(b.cards[0]!.routed_llm).toBeUndefined();
    expect(b.empty_slots[0]!.reason).toBe("no verified candidate");
    expect(b.empty_slots[0]!.relax).toBeUndefined();
    expect(b.refusals[0]).not.toHaveProperty("moved_to");
    expect(b.refusals[0]).not.toHaveProperty("struck_by_toggle");
  });

  it("planDocFromToggle and weekPlanFromDoc keep clinician, struck and moved refusals and the empty-slot relax", async () => {
    const { plan, cards } = await realWeek();
    const card = cards.find((x) => x.slot.rung === "solo")!;
    const w: WeekPlan = {
      week: 1,
      calls: [],
      review: [],
      slots: [
        { slot: card.slot, card },
        { slot: { day: "sunday", hour: 10, rung: "solo" }, card: null },
        { slot: { day: "saturday", hour: 11, rung: "solo" }, card: null, empty: "all closed", relax: { price: 3 } },
      ],
      refusals: [
        { day: "monday", hour: 9, entity_id: "e1", name: "A", rule: "R-OPEN", detail: "d", verdict: "REFUSE", movedTo: 12, struckByToggle: true, byClinician: "swapped" },
        { day: "tuesday", hour: 9, entity_id: "e2", name: "B", rule: "R-ALC", detail: "d", verdict: "REFUSE" },
      ],
    };
    const doc = planDocFromToggle(plan, w, { caseId: "c2", changed: {}, struck: 0, refilled: 0, ms: 1, calls: 0, coach: () => "x" });
    expect(doc.empty_slots.map((e) => [e.day_name, e.reason, e.relax])).toEqual([
      ["sunday", "no verified candidate", undefined],
      ["saturday", "all closed", { price: 3 }],
    ]);
    expect(doc.refusals[0]).toMatchObject({ moved_to: 12, struck_by_toggle: true, by_clinician: "swapped" });
    expect(doc.refusals[1]).not.toHaveProperty("by_clinician");
    const back = weekPlanFromDoc(doc);
    expect(back.refusals[0]).toMatchObject({ movedTo: 12, struckByToggle: true, byClinician: "swapped" });
    expect(back.refusals[1]).not.toHaveProperty("byClinician");
    expect(back.slots.find((s) => s.slot.day === "saturday")).toMatchObject({ card: null, empty: "all closed", relax: { price: 3 } });
  });
});

describe("cov-c store: MemoryStore list ordering", () => {
  it("equal and unparseable creation dates sort by write order; the unparseable one is oldest", async () => {
    const s = new MemoryStore();
    const { plan } = await realWeek();
    const mk = (created_at: string) => PlanDoc.parse({ ...plan, id: crypto.randomUUID(), created_at });
    const a = mk("2026-10-08T00:00:00.000Z");
    const b = mk("2026-10-08T00:00:00.000Z");
    const bad = mk("not a date");
    for (const p of [a, b, bad]) await s.putPlan(p);
    expect(await s.listPlanIds()).toEqual([b.id, a.id, bad.id]);
  });
});

describe("cov-c store: BlobStore on an in-memory object store", () => {
  afterEach(() => vi.clearAllMocks());

  function fakeBlob() {
    const objs = new Map<string, { text: string; etag: string; at: Date }>();
    let n = 0;
    blob.get.mockImplementation(async (path: string) => {
      const o = objs.get(path);
      return o ? { stream: streamOf(o.text), blob: { etag: o.etag } } : null;
    });
    blob.put.mockImplementation(async (path: string, body: string, opts: { allowOverwrite: boolean; ifMatch?: string }) => {
      const o = objs.get(path);
      const { BlobPreconditionFailedError } = await import("@vercel/blob");
      if (o && !opts.allowOverwrite) throw new Error("This blob already exists");
      if (o && opts.ifMatch && opts.ifMatch !== o.etag) throw new BlobPreconditionFailedError();
      objs.set(path, { text: body, etag: `e${++n}`, at: new Date(Date.UTC(2026, 9, 8, 0, 0, n)) });
    });
    blob.list.mockImplementation(async ({ prefix }: { prefix: string }) => ({ blobs: [...objs.entries()].filter(([p]) => p.startsWith(prefix)).map(([p, o]) => ({ pathname: p, uploadedAt: o.at })) }));
    return objs;
  }

  it("round-trips documents; a blob without a stream and a missing blob both read as missing", async () => {
    const objs = fakeBlob();
    const s = new BlobStore("tok", "bench/");
    const c = caseFromSeed("maya")!;
    await s.putCase(c);
    expect(await s.getCase(c.id)).toEqual(c);
    expect(await s.getCase(crypto.randomUUID())).toBeNull();
    const path = [...objs.keys()][0]!;
    blob.get.mockResolvedValueOnce({ stream: null, blob: { etag: "x" } });
    expect(await s.getCase(c.id)).toBeNull();
    expect(path).toContain(c.id);
  });

  it("plans and call logs round-trip through the object store", async () => {
    fakeBlob();
    const s = new BlobStore("tok");
    const { plan } = await realWeek();
    await s.putPlan(plan);
    expect(await s.getPlan(plan.id)).toEqual(plan);
    const calls = callsDoc(plan.id, [{ path: "/v2/insights", params: { a: "b" }, status: 200, ms: 3, n_results: 1, attempts: 1, at: iso }]);
    await s.putCalls(calls);
    expect(await s.getCalls(plan.id)).toEqual(calls);
  });

  it("run markers: re-plan markers live under their parent plan; a claim is create-only, then ETag-conditional when reclaimable", async () => {
    const objs = fakeBlob();
    const s = new BlobStore("tok");
    const parent = crypto.randomUUID();
    const caseId = crypto.randomUUID();
    await s.putRun(runIn(caseId, { parent_plan_id: parent }));
    expect((await s.getReplanRun(parent))?.status).toBe("running");
    expect(await s.getRun(caseId)).toBeNull();
    expect(await s.claimRun(runIn(caseId), () => false)).toBeNull(); // first claim wins
    const cur = await s.claimRun(runIn(caseId, { started_at: "later" }), () => false);
    expect(cur?.started_at).toBe(iso); // second sees the winner
    expect(await s.claimRun(runIn(caseId, { started_at: "reclaimed" }), () => true)).toBeNull();
    expect((await s.getRun(caseId))?.started_at).toBe("reclaimed");
    expect(objs.size).toBe(2);
  });

  it("a lost claim race returns the winner's marker (precondition failure or already-exists), or the caller's own when it cannot be read; other errors are unavailable", async () => {
    const { BlobPreconditionFailedError } = await import("@vercel/blob");
    const s = new BlobStore("tok");
    const caseId = crypto.randomUUID();
    const winner = JSON.stringify({ case_id: caseId, parent_plan_id: null, status: "running", plan_id: null, started_at: "winner", updated_at: iso });
    // existing reclaimable marker; our conditional put loses to another claim that already replaced it
    blob.get.mockResolvedValueOnce({ stream: streamOf(JSON.stringify(runIn(caseId, { status: "failed" }))), blob: { etag: "old" } });
    blob.put.mockRejectedValueOnce(new BlobPreconditionFailedError());
    blob.get.mockResolvedValueOnce({ stream: streamOf(winner), blob: { etag: "new" } });
    expect((await s.claimRun(runIn(caseId), () => true))?.started_at).toBe("winner");
    // no marker; create-only put loses with "already exists"; re-reading the winner's marker fails -> our own doc comes back
    blob.get.mockResolvedValueOnce(null);
    blob.put.mockRejectedValueOnce(new Error("Blob already exists"));
    blob.get.mockRejectedValueOnce(new Error("read failed"));
    expect((await s.claimRun(runIn(caseId, { started_at: "mine" }), () => true))?.started_at).toBe("mine");
    blob.get.mockResolvedValueOnce(null);
    blob.put.mockRejectedValueOnce(new Error("boom"));
    await expect(s.claimRun(runIn(caseId), () => true)).rejects.toBeInstanceOf(StoreUnavailable);
  });

  it("listPlanIds returns newest upload first within the limit", async () => {
    fakeBlob();
    const s = new BlobStore("tok");
    const { plan } = await realWeek();
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids) await s.putPlan(PlanDoc.parse({ ...plan, id }));
    expect(await s.listPlanIds(2)).toEqual([ids[2], ids[1]]);
  });
});

describe("cov-c store: STORE_FAULT=unavailable", () => {
  it.each([
    ["redis", { KV_REST_API_URL: "https://r.example", KV_REST_API_TOKEN: "t" }],
    ["blob", { BLOB_READ_WRITE_TOKEN: "tok" }],
  ])("the %s backend is replaced by a store whose every call is unavailable", async (kind, env) => {
    const f = storeFromEnv({ ...env, STORE_FAULT: "unavailable" }, `cov-c-${kind}/` as never) as FailoverStore;
    expect(f.primary.kind).toBe(kind);
    const id = crypto.randomUUID();
    const c = caseFromSeed("maya")!;
    const calls = [
      () => f.primary.putCase(c),
      () => f.primary.getCase(id),
      () => f.primary.putPlan({} as never),
      () => f.primary.getPlan(id),
      () => f.primary.putCalls({} as never),
      () => f.primary.getCalls(id),
      () => f.primary.putRun(runIn(id)),
      () => f.primary.getRun(id),
      () => f.primary.getReplanRun(id),
      () => f.primary.claimRun(runIn(id), () => true),
      () => f.primary.listPlanIds(),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(StoreUnavailable);
  });
});

describe("cov-c store: FailoverStore delegates every operation to a healthy primary", () => {
  it("documents, calls, run markers and the plan index all go through", async () => {
    const f = new FailoverStore(new MemoryStore(), new MemoryStore());
    const { c, plan } = await realWeek();
    await f.putCase(c);
    await f.putPlan(plan);
    const calls = callsDoc(plan.id, [{ path: "/v2/insights", params: {}, status: 200, ms: 1, n_results: 0, attempts: 1, at: iso }]);
    await f.putCalls(calls);
    await f.putRun(runIn(c.id, { parent_plan_id: plan.id }));
    expect([await f.getCase(c.id), await f.getPlan(plan.id), await f.getCalls(plan.id)]).toEqual([c, plan, calls]);
    expect(await f.getRun(c.id)).toBeNull();
    expect((await f.getReplanRun(plan.id))?.status).toBe("running");
    expect(await f.claimRun(runIn(c.id), () => false)).toBeNull();
    expect(await f.listPlanIds()).toEqual([plan.id]);
  });
});

describe("cov-c store: RedisStore, FailoverStore, envKeyPrefix", () => {
  it("RedisStore.claimRun returns the caller's own doc when the winner's marker has vanished; limit <= 0 lists nothing", async () => {
    const r = new FakeRedis();
    const s = new RedisStore(r, "", "");
    const caseId = crypto.randomUUID();
    // the create-only SET loses (not "OK") and the marker is gone again by the re-read
    r.set = (async () => null) as typeof r.set;
    const mine = await s.claimRun(runIn(caseId, { started_at: "mine" }), () => true);
    expect(mine?.started_at).toBe("mine");
    expect(await s.listPlanIds(0)).toEqual([]);
    expect(await s.listPlanIds(-3)).toEqual([]);
  });

  it("envKeyPrefix defaults to process.env: previews and dev write under preview/, production and unset do not", () => {
    for (const [v, want] of [[undefined, ""], ["production", ""], ["preview", "preview/"], ["development", "preview/"]] as const) {
      vi.stubEnv("VERCEL_ENV", v as string);
      if (v === undefined) vi.unstubAllEnvs();
      expect(envKeyPrefix()).toBe(want);
    }
    vi.unstubAllEnvs();
    expect(envKeyPrefix({ VERCEL_ENV: "preview" })).toBe("preview/");
  });

  it("FailoverStore logs a StoreUnavailable that carries no reason", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const down = new Proxy({ kind: "redis" } as Store, { get: (t, k) => (k === "kind" ? "redis" : async () => { throw new StoreUnavailable(); }) });
    const f = new FailoverStore(down, new MemoryStore(), () => 1);
    await f.putCase(caseFromSeed("maya")!);
    expect(f.degraded()).toBe(true);
    expect(err.mock.calls[0]![1]).toBeInstanceOf(StoreUnavailable);
    err.mockRestore();
  });
});
